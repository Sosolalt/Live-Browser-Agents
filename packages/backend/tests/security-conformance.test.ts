import crypto from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { AuditLogger } from "../src/logger.js";

type TestJwk = Record<string, string | undefined>;

const fixedNow = 1_715_000_000_000;
const installId = "install-security-01";

const baseConfig: AppConfig = {
  port: 3000,
  sessionCredentialSigningSecret: "session-credential-signing-secret-123456",
  sessionMintingEnabled: true,
  requestMaxAgeMs: 60_000,
  nonceTtlMs: 60_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxPerIp: 2,
  rateLimitMaxPerInstallId: 2,
  geminiModel: "models/test",
  geminiVoice: "TestVoice",
  geminiLiveWebSocketUrl: "wss://example.test/live",
  policyVersion: "test-v1",
  guardrails: ["test-safe"]
};

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

describe("session-init security conformance", () => {
  it("rejects unknown install IDs", async () => {
    const { privateKey } = await generateInstallKeypair();
    const nonce = "nonce-unknown-0001";
    const signature = await signPayload(privateKey, `${installId}\n${fixedNow}\n${nonce}`);
    const app = createApp({ config: baseConfig, getNowMs: () => fixedNow });

    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp: fixedNow,
      nonce,
      signature
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unknown_install");
  });

  it("rejects spoofed signatures after install registration", async () => {
    const trusted = await generateInstallKeypair();
    const attacker = await generateInstallKeypair();
    const nonce = "nonce-spoof-0001";
    const app = createApp({ config: baseConfig, getNowMs: () => fixedNow });
    await request(app).post("/api/install/register").send({ installId, publicKeyJwk: trusted.publicKeyJwk }).expect(200);

    const spoofedSignature = await signPayload(attacker.privateKey, `${installId}\n${fixedNow}\n${nonce}`);
    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp: fixedNow,
      nonce,
      signature: spoofedSignature
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("invalid_auth");
  });

  it("returns not_ready when live websocket URL is missing", async () => {
    const { privateKey, publicKeyJwk } = await generateInstallKeypair();
    const app = createApp({
      config: { ...baseConfig, geminiLiveWebSocketUrl: "" },
      getNowMs: () => fixedNow
    });
    await request(app).post("/api/install/register").send({ installId, publicKeyJwk }).expect(200);
    const nonce = "nonce-not-ready-0001";
    const signature = await signPayload(privateKey, `${installId}\n${fixedNow}\n${nonce}`);

    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp: fixedNow,
      nonce,
      signature
    });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("not_ready");
  });

  it("logs reject reasons without leaking signature", async () => {
    const logs: Array<{ level: "info" | "warn"; event: string; payload: Record<string, unknown> }> = [];
    const logger: AuditLogger = {
      info(event, payload) {
        logs.push({ level: "info", event, payload });
      },
      warn(event, payload) {
        logs.push({ level: "warn", event, payload });
      }
    };
    const trusted = await generateInstallKeypair();
    const attacker = await generateInstallKeypair();
    const nonce = "nonce-spoof-log-0001";
    const app = createApp({ config: baseConfig, getNowMs: () => fixedNow, logger });
    await request(app).post("/api/install/register").send({ installId, publicKeyJwk: trusted.publicKeyJwk }).expect(200);
    const spoofedSignature = await signPayload(attacker.privateKey, `${installId}\n${fixedNow}\n${nonce}`);

    const response = await request(app).post("/api/session-init").send({
      installId,
      timestamp: fixedNow,
      nonce,
      signature: spoofedSignature
    });

    expect(response.status).toBe(401);
    const rejectedEvent = logs.find((entry) => entry.event === "session_init.rejected");
    expect(rejectedEvent?.payload.reason).toBe("invalid_signature");
    expect(JSON.stringify(logs).includes(spoofedSignature)).toBe(false);
  });
});
