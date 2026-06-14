import crypto from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AuditLogger } from "../src/logger.js";

const signingSecret = "session-credential-signing-secret-123456";
const fixedNow = 1_715_000_000_000;

const config: AppConfig = {
  port: 3000,
  sessionCredentialSigningSecret: signingSecret,
  sessionMintingEnabled: true,
  requestMaxAgeMs: 60_000,
  nonceTtlMs: 60_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxPerIp: 100,
  rateLimitMaxPerInstallId: 100,
  geminiModel: "models/test",
  geminiVoice: "TestVoice",
  geminiLiveWebSocketUrl: "wss://example.test/live",
  policyVersion: "test-v1",
  guardrails: ["test-safe"],
  memoryEncryptionKey: "test-memory-encryption-key-0001",
  embeddingDimensions: 64,
  orchestratorMaxSteps: 12,
  orchestratorMaxToolCalls: 24,
  orchestratorMaxCostMicros: 5_000_000,
  blockedDomains: ["paypal.com"]
};

const silentLogger: AuditLogger = { info: () => undefined, warn: () => undefined };

const b64url = (value: Buffer): string =>
  value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const mintToken = (installId: string, nowMs: number, secret = signingSecret): string => {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        sub: installId,
        aud: "gemini-live",
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor((nowMs + 5 * 60_000) / 1000)
      })
    )
  );
  const sig = b64url(crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
};

const makeApp = () => createApp({ config, getNowMs: () => fixedNow, logger: silentLogger });

describe("orchestrate + memory endpoints", () => {
  it("rejects unauthenticated and invalid credentials", async () => {
    const app = makeApp();
    await request(app).post("/api/orchestrate").send({ sessionId: "s", intent: "x" }).expect(401);
    await request(app)
      .post("/api/orchestrate")
      .set("Authorization", "Bearer not.a.token")
      .send({ sessionId: "s", intent: "x" })
      .expect(401);
  });

  it("runs an orchestration and exposes its event stream", async () => {
    const app = makeApp();
    const token = mintToken("install-orch-1", fixedNow);
    const res = await request(app)
      .post("/api/orchestrate")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "session-1", intent: "search for running shoes and extract results" })
      .expect(200);

    expect(res.body.status).toBe("done");
    expect(res.body.terminationReason).toBe("completed");
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.tasks.length).toBeGreaterThan(0);
    expect(res.body.events.some((e: { type: string }) => e.type === "plan_created")).toBe(true);

    const runId = res.body.runId as string;
    const stream = await request(app)
      .get(`/api/orchestrate/${runId}/events`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);
    expect(stream.text).toContain("run_finished");
  });

  it("isolates one install's run events from another", async () => {
    const app = makeApp();
    const tokenA = mintToken("install-A", fixedNow);
    const tokenB = mintToken("install-B", fixedNow);
    const res = await request(app)
      .post("/api/orchestrate")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ sessionId: "sa", intent: "extract the page" })
      .expect(200);
    await request(app)
      .get(`/api/orchestrate/${res.body.runId}/events`)
      .set("Authorization", `Bearer ${tokenB}`)
      .expect(403);
  });

  it("terminates with critic_veto for a blocked-domain action", async () => {
    const app = makeApp();
    const token = mintToken("install-veto", fixedNow);
    const res = await request(app)
      .post("/api/orchestrate")
      .set("Authorization", `Bearer ${token}`)
      .send({ sessionId: "sv", intent: "go to https://paypal.com and pay the invoice" })
      .expect(200);
    expect(res.body.status).toBe("terminated");
    expect(res.body.terminationReason).toBe("critic_veto");
  });

  it("writes memory, exports it, then forgets and pauses", async () => {
    const app = makeApp();
    const token = mintToken("install-mem", fixedNow);
    await request(app)
      .post("/api/orchestrate")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sessionId: "sm",
        intent: "extract the product page",
        snapshot: { url: "https://shop.test/p", title: "Product", elements: [], text: "a product" }
      })
      .expect(200);

    const graph = await request(app).get("/api/memory/graph").set("Authorization", `Bearer ${token}`).expect(200);
    expect(graph.body.nodes.length).toBeGreaterThan(0);

    const exported = await request(app).post("/api/memory/export").set("Authorization", `Bearer ${token}`).send({}).expect(200);
    expect(exported.body.installId).toBe("install-mem");
    expect(exported.body.nodes.some((n: { type: string }) => n.type === "PageVisit")).toBe(true);

    const forget = await request(app)
      .post("/api/memory/forget")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: { kind: "domain", domain: "shop.test" } })
      .expect(200);
    expect(forget.body.removed).toBeGreaterThan(0);

    const pause = await request(app)
      .post("/api/memory/pause")
      .set("Authorization", `Bearer ${token}`)
      .send({ paused: true })
      .expect(200);
    expect(pause.body.paused).toBe(true);
  });

  it("validates request payloads", async () => {
    const app = makeApp();
    const token = mintToken("install-validate", fixedNow);
    await request(app).post("/api/orchestrate").set("Authorization", `Bearer ${token}`).send({ intent: "" }).expect(400);
    await request(app)
      .post("/api/memory/forget")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: { kind: "bogus" } })
      .expect(400);
  });
});
