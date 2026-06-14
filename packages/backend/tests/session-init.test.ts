import crypto from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AuditLogger } from "../src/logger.js";

type TestJwk = Record<string, string | undefined>;

const fixedNow = 1_715_000_000_000;
const signingSecret = "session-credential-signing-secret-123456";
const installId = "install-test-01";

const generateInstallKeypair = async (): Promise<{ privateKey: crypto.webcrypto.CryptoKey; publicKeyJwk: TestJwk }> => {
  const keyPair = await crypto.webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicKeyJwk = (await crypto.webcrypto.subtle.exportKey("jwk", keyPair.publicKey)) as TestJwk;
  return { privateKey: keyPair.privateKey, publicKeyJwk };
};

const signPayload = async (privateKey: crypto.webcrypto.CryptoKey, payload: string): Promise<string> => {
  const sig = await crypto.webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return Buffer.from(sig).toString("base64");
};

const testConfig: AppConfig = {
  port: 3000,
  sessionCredentialSigningSecret: signingSecret,
  sessionMintingEnabled: true,
  requestMaxAgeMs: 60_000,
  nonceTtlMs: 60_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxPerIp: 30,
  rateLimitMaxPerInstallId: 10,
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

describe("POST /api/session-init", () => {
  it("accepts a valid authenticated request", async () => {
    const timestamp = fixedNow;
    const nonce = "nonce-valid-0001";
    const { privateKey, publicKeyJwk } = await generateInstallKeypair();
    const signature = await signPayload(privateKey, `${installId}\n${timestamp}\n${nonce}`);
    const app = createApp({ config: testConfig, getNowMs: () => fixedNow });
    await request(app).post("/api/install/register").send({ installId, publicKeyJwk }).expect(200);

    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp,
      nonce,
      signature
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      session: {
        tokenType: "ephemeral"
      },
      startupConfig: {
        model: "models/test",
        voice: "TestVoice",
        liveWebSocketUrl: "wss://example.test/live",
        policyVersion: "test-v1",
        guardrails: ["test-safe"]
      }
    });
    expect(response.body.startupConfig.snapshotPolicy).toEqual({
      minScoreDefault: 4,
      minConfidenceDefault: 0.6,
      minScoreSensitive: 2,
      minConfidenceSensitive: 0.65,
      policyVersion: "test-v1"
    });
    expect(response.body.session.accessToken.split(".")).toHaveLength(3);
  });

  it("rejects replayed nonce in active window", async () => {
    const timestamp = fixedNow;
    const nonce = "nonce-replay-0001";
    const { privateKey, publicKeyJwk } = await generateInstallKeypair();
    const signature = await signPayload(privateKey, `${installId}\n${timestamp}\n${nonce}`);
    const app = createApp({ config: testConfig, getNowMs: () => fixedNow });
    await request(app).post("/api/install/register").send({ installId, publicKeyJwk }).expect(200);

    const firstResponse = await request(app).post("/api/session-init").send({
      installId,
      timestamp,
      nonce,
      signature
    });
    const replayResponse = await request(app).post("/api/session-init").send({
      installId,
      timestamp,
      nonce,
      signature
    });

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(409);
    expect(replayResponse.body).toEqual({
      error: {
        code: "replay_detected",
        message: "Nonce already used in active window.",
        details: {}
      }
    });
  });

  it("rejects stale timestamp", async () => {
    const timestamp = fixedNow - 61_000;
    const nonce = "nonce-stale-0001";
    const { privateKey, publicKeyJwk } = await generateInstallKeypair();
    const signature = await signPayload(privateKey, `${installId}\n${timestamp}\n${nonce}`);
    const app = createApp({ config: testConfig, getNowMs: () => fixedNow });
    await request(app).post("/api/install/register").send({ installId, publicKeyJwk }).expect(200);

    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp,
      nonce,
      signature
    });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: {
        code: "stale_timestamp",
        message: "Timestamp outside accepted window.",
        details: {
          maxAgeMs: 60000
        }
      }
    });
  });

  it("returns service_disabled when emergency switch is off", async () => {
    const app = createApp({
      config: {
        ...testConfig,
        sessionMintingEnabled: false,
        sessionMintingDisableReason: "Emergency maintenance window."
      },
      getNowMs: () => fixedNow
    });

    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp: fixedNow,
      nonce: "any-nonce",
      signature: "invalid"
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: "service_disabled",
        message: "Emergency maintenance window.",
        details: {}
      }
    });
  });

  it("emits redacted structured audit events", async () => {
    const logs: Array<{ level: "info" | "warn"; event: string; payload: Record<string, unknown> }> = [];
    const logger: AuditLogger = {
      info(event, payload) {
        logs.push({ level: "info", event, payload });
      },
      warn(event, payload) {
        logs.push({ level: "warn", event, payload });
      }
    };
    const timestamp = fixedNow;
    const nonce = "nonce-audit-0001";
    const { privateKey, publicKeyJwk } = await generateInstallKeypair();
    const signature = await signPayload(privateKey, `${installId}\n${timestamp}\n${nonce}`);
    const app = createApp({ config: testConfig, getNowMs: () => fixedNow, logger });

    await request(app).post("/api/install/register").send({ installId, publicKeyJwk }).expect(200);
    await request(app).post("/api/session-init").send({
      installId,
      timestamp,
      nonce,
      signature
    });

    expect(logs.some((entry) => entry.event === "install_register.completed")).toBe(true);
    expect(logs.some((entry) => entry.event === "session_init.request_received")).toBe(true);
    expect(logs.some((entry) => entry.event === "session_init.completed")).toBe(true);

    const serialized = JSON.stringify(logs);
    expect(serialized.includes(signature)).toBe(false);
    expect(serialized.includes(nonce)).toBe(false);
    expect(serialized.includes("accessToken")).toBe(false);

    const requestReceived = logs.find((entry) => entry.event === "session_init.request_received");
    expect(typeof requestReceived?.payload.installIdHash).toBe("string");
    expect(typeof requestReceived?.payload.nonceHash).toBe("string");
  });

  it("rejects install key overwrite attempts for an existing install ID", async () => {
    const app = createApp({ config: testConfig, getNowMs: () => fixedNow });
    const firstRegistration = await generateInstallKeypair();
    const secondRegistration = await generateInstallKeypair();

    const first = await request(app)
      .post("/api/install/register")
      .send({ installId: "install-immutable-01", publicKeyJwk: firstRegistration.publicKeyJwk });
    expect(first.status).toBe(200);

    const overwriteAttempt = await request(app)
      .post("/api/install/register")
      .send({ installId: "install-immutable-01", publicKeyJwk: secondRegistration.publicKeyJwk });
    expect(overwriteAttempt.status).toBe(409);
    expect(overwriteAttempt.body).toEqual({
      error: {
        code: "install_already_registered",
        message: "Install ID is already registered.",
        details: {}
      }
    });
  });

  it("enforces per-IP rate limits and recovers after window reset", async () => {
    let nowMs = fixedNow;
    const config: AppConfig = {
      ...testConfig,
      rateLimitWindowMs: 1_000,
      rateLimitMaxPerIp: 1,
      rateLimitMaxPerInstallId: 10
    };
    const app = createApp({ config, getNowMs: () => nowMs });

    const installA = await generateInstallKeypair();
    const installB = await generateInstallKeypair();
    await request(app).post("/api/install/register").send({ installId: "install-ip-a", publicKeyJwk: installA.publicKeyJwk }).expect(200);
    await request(app).post("/api/install/register").send({ installId: "install-ip-b", publicKeyJwk: installB.publicKeyJwk }).expect(200);

    const firstTimestamp = nowMs;
    const firstSignature = await signPayload(installA.privateKey, `install-ip-a\n${firstTimestamp}\nnonce-ip-1`);
    const first = await request(app).post("/api/session-init").send({
      installId: "install-ip-a",
      timestamp: firstTimestamp,
      nonce: "nonce-ip-1",
      signature: firstSignature
    });
    expect(first.status).toBe(200);

    const blockedTimestamp = nowMs;
    const blockedSignature = await signPayload(installB.privateKey, `install-ip-b\n${blockedTimestamp}\nnonce-ip-2`);
    const blocked = await request(app).post("/api/session-init").send({
      installId: "install-ip-b",
      timestamp: blockedTimestamp,
      nonce: "nonce-ip-2",
      signature: blockedSignature
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
    expect(blocked.body.error.details.scope).toBe("ip");

    nowMs += 1_001;
    const recoveredTimestamp = nowMs;
    const recoveredSignature = await signPayload(installB.privateKey, `install-ip-b\n${recoveredTimestamp}\nnonce-ip-3`);
    const recovered = await request(app).post("/api/session-init").send({
      installId: "install-ip-b",
      timestamp: recoveredTimestamp,
      nonce: "nonce-ip-3",
      signature: recoveredSignature
    });
    expect(recovered.status).toBe(200);
  });

  it("enforces per-install rate limits and recovers after window reset", async () => {
    let nowMs = fixedNow;
    const config: AppConfig = {
      ...testConfig,
      rateLimitWindowMs: 1_000,
      rateLimitMaxPerIp: 10,
      rateLimitMaxPerInstallId: 1
    };
    const app = createApp({ config, getNowMs: () => nowMs });
    const install = await generateInstallKeypair();
    const rateLimitedInstallId = "install-limit-01";
    await request(app)
      .post("/api/install/register")
      .send({ installId: rateLimitedInstallId, publicKeyJwk: install.publicKeyJwk })
      .expect(200);

    const firstTimestamp = nowMs;
    const firstSignature = await signPayload(install.privateKey, `${rateLimitedInstallId}\n${firstTimestamp}\nnonce-install-1`);
    const first = await request(app).post("/api/session-init").send({
      installId: rateLimitedInstallId,
      timestamp: firstTimestamp,
      nonce: "nonce-install-1",
      signature: firstSignature
    });
    expect(first.status).toBe(200);

    const blockedTimestamp = nowMs;
    const blockedSignature = await signPayload(install.privateKey, `${rateLimitedInstallId}\n${blockedTimestamp}\nnonce-install-2`);
    const blocked = await request(app).post("/api/session-init").send({
      installId: rateLimitedInstallId,
      timestamp: blockedTimestamp,
      nonce: "nonce-install-2",
      signature: blockedSignature
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("rate_limited");
    expect(blocked.body.error.details.scope).toBe("installId");

    nowMs += 1_001;
    const recoveredTimestamp = nowMs;
    const recoveredSignature = await signPayload(
      install.privateKey,
      `${rateLimitedInstallId}\n${recoveredTimestamp}\nnonce-install-3`
    );
    const recovered = await request(app).post("/api/session-init").send({
      installId: rateLimitedInstallId,
      timestamp: recoveredTimestamp,
      nonce: "nonce-install-3",
      signature: recoveredSignature
    });
    expect(recovered.status).toBe(200);
  });
});
