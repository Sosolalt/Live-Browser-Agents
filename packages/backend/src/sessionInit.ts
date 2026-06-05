import crypto from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { toHashedField, type AuditLogger } from "./logger.js";

type StoredJwk = Record<string, string | undefined>;

type RequestContext = {
  nowMs: number;
  installId: string;
  ipAddress: string;
};

type SessionInitRequest = {
  installId: string;
  timestamp: number;
  nonce: string;
  signature: string;
};

type InstallRegisterRequest = {
  installId: string;
  publicKeyJwk: StoredJwk;
};

type RateLimitState = {
  count: number;
  resetAtMs: number;
};

type SessionInitDeps = {
  config: AppConfig;
  getNowMs: () => number;
  usedNonces: Map<string, number>;
  ipRateLimitMap: Map<string, RateLimitState>;
  installRateLimitMap: Map<string, RateLimitState>;
  installPublicKeys: Map<string, StoredJwk>;
  logger: AuditLogger;
};

const requestSchema = z.object({
  installId: z.string().min(3).max(128),
  timestamp: z.coerce.number().int().positive(),
  nonce: z.string().min(8).max(256),
  signature: z.string().min(16)
});

const registerSchema = z.object({
  installId: z.string().min(3).max(128),
  publicKeyJwk: z.object({
    kty: z.string(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional()
  }).passthrough()
});

const canonicalPayload = (payload: Pick<SessionInitRequest, "installId" | "timestamp" | "nonce">): string =>
  `${payload.installId}\n${payload.timestamp}\n${payload.nonce}`;

const jsonError = (
  res: Response,
  status: number,
  code:
    | "invalid_auth"
    | "replay_detected"
    | "stale_timestamp"
    | "rate_limited"
    | "unknown_install"
    | "not_ready"
    | "service_disabled"
    | "install_already_registered",
  message: string,
  details?: Record<string, unknown>
): Response =>
  res.status(status).json({
    error: {
      code,
      message,
      details: details ?? {}
    }
  });

const cleanupExpiredNonces = (nonceMap: Map<string, number>, nowMs: number): void => {
  for (const [nonce, expiresAt] of nonceMap.entries()) {
    if (expiresAt <= nowMs) {
      nonceMap.delete(nonce);
    }
  }
};

const consumeNonce = (nonceMap: Map<string, number>, nonce: string, nowMs: number, ttlMs: number): boolean => {
  cleanupExpiredNonces(nonceMap, nowMs);
  if (nonceMap.has(nonce)) {
    return false;
  }
  nonceMap.set(nonce, nowMs + ttlMs);
  return true;
};

const consumeRateLimitToken = (
  stateMap: Map<string, RateLimitState>,
  key: string,
  nowMs: number,
  windowMs: number,
  maxHits: number
): { allowed: boolean; retryAfterSeconds?: number } => {
  const current = stateMap.get(key);
  if (!current || current.resetAtMs <= nowMs) {
    stateMap.set(key, { count: 1, resetAtMs: nowMs + windowMs });
    return { allowed: true };
  }

  if (current.count >= maxHits) {
    return { allowed: false, retryAfterSeconds: Math.ceil((current.resetAtMs - nowMs) / 1000) };
  }

  current.count += 1;
  stateMap.set(key, current);
  return { allowed: true };
};

const getIpAddress = (req: Request): string => req.ip || req.socket.remoteAddress || "unknown";

const decodeBase64 = (value: string): Buffer => Buffer.from(value, "base64");

const validateAuth = (request: SessionInitRequest, publicKeyJwk: StoredJwk): boolean => {
  const payload = Buffer.from(canonicalPayload(request), "utf8");
  const signature = decodeBase64(request.signature);
  const publicKey = crypto.createPublicKey({
    key: publicKeyJwk,
    format: "jwk"
  });
  return crypto.verify("sha256", payload, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
};

const staleTimestamp = (timestamp: number, nowMs: number, maxAgeMs: number): boolean =>
  Math.abs(nowMs - timestamp) > maxAgeMs;

const toBase64Url = (value: Buffer): string =>
  value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const signSessionCredential = (installId: string, config: AppConfig, nowMs: number): string => {
  const header = toBase64Url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = toBase64Url(
    Buffer.from(
      JSON.stringify({
        sub: installId,
        aud: "gemini-live",
        iat: Math.floor(nowMs / 1000),
        exp: Math.floor((nowMs + 5 * 60_000) / 1000)
      })
    )
  );
  const signature = toBase64Url(
    crypto.createHmac("sha256", config.sessionCredentialSigningSecret).update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
};

const snapshotPolicyForVersion = (policyVersion: string) => {
  if (policyVersion.startsWith("strict")) {
    return {
      minScoreDefault: 5,
      minConfidenceDefault: 0.65,
      minScoreSensitive: 3,
      minConfidenceSensitive: 0.75,
      policyVersion
    };
  }
  return {
    minScoreDefault: 4,
    minConfidenceDefault: 0.6,
    minScoreSensitive: 2,
    minConfidenceSensitive: 0.65,
    policyVersion
  };
};

const sessionInitResponse = (config: AppConfig, nowMs: number, installId: string) => {
  const expiresAtMs = nowMs + 5 * 60_000;
  return {
    session: {
      tokenType: "ephemeral",
      accessToken: signSessionCredential(installId, config, nowMs),
      expiresAt: new Date(expiresAtMs).toISOString()
    },
    startupConfig: {
      model: config.geminiModel,
      voice: config.geminiVoice,
      liveWebSocketUrl: config.geminiLiveWebSocketUrl,
      policyVersion: config.policyVersion,
      guardrails: config.guardrails,
      snapshotPolicy: snapshotPolicyForVersion(config.policyVersion)
    }
  };
};

const parseRequest = (body: unknown): SessionInitRequest => requestSchema.parse(body);
const parseRegisterRequest = (body: unknown): InstallRegisterRequest => registerSchema.parse(body) as InstallRegisterRequest;

const buildContext = (req: Request, installId: string, nowMs: number): RequestContext => ({
  nowMs,
  installId,
  ipAddress: getIpAddress(req)
});

export const createSessionInitHandler = (deps: SessionInitDeps) => (req: Request, res: Response): Response => {
  const requestStartedAtMs = deps.getNowMs();
  const requestId = crypto.randomUUID();

  if (!deps.config.sessionMintingEnabled) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      reason: "service_disabled",
      httpStatus: 503
    });
    return jsonError(
      res,
      503,
      "service_disabled",
      deps.config.sessionMintingDisableReason ?? "Session minting is temporarily disabled."
    );
  }

  let parsedRequest: SessionInitRequest;
  try {
    parsedRequest = parseRequest(req.body);
  } catch (_error) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      reason: "invalid_payload",
      httpStatus: 401
    });
    return jsonError(res, 401, "invalid_auth", "Request payload is invalid.");
  }

  const nowMs = deps.getNowMs();
  const context = buildContext(req, parsedRequest.installId, nowMs);
  const installIdHash = toHashedField(parsedRequest.installId);
  const ipHash = toHashedField(context.ipAddress);
  const nonceHash = toHashedField(parsedRequest.nonce);

  deps.logger.info("session_init.request_received", {
    requestId,
    installIdHash,
    ipHash,
    nonceHash
  });

  const ipRate = consumeRateLimitToken(
    deps.ipRateLimitMap,
    context.ipAddress,
    context.nowMs,
    deps.config.rateLimitWindowMs,
    deps.config.rateLimitMaxPerIp
  );
  if (!ipRate.allowed) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "rate_limited_ip",
      httpStatus: 429,
      retryAfterSeconds: ipRate.retryAfterSeconds
    });
    return jsonError(res, 429, "rate_limited", "IP rate limit exceeded.", {
      scope: "ip",
      retryAfterSeconds: ipRate.retryAfterSeconds
    });
  }

  const installRate = consumeRateLimitToken(
    deps.installRateLimitMap,
    context.installId,
    context.nowMs,
    deps.config.rateLimitWindowMs,
    deps.config.rateLimitMaxPerInstallId
  );
  if (!installRate.allowed) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "rate_limited_install",
      httpStatus: 429,
      retryAfterSeconds: installRate.retryAfterSeconds
    });
    return jsonError(res, 429, "rate_limited", "Install ID rate limit exceeded.", {
      scope: "installId",
      retryAfterSeconds: installRate.retryAfterSeconds
    });
  }

  if (staleTimestamp(parsedRequest.timestamp, context.nowMs, deps.config.requestMaxAgeMs)) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "stale_timestamp",
      httpStatus: 401
    });
    return jsonError(res, 401, "stale_timestamp", "Timestamp outside accepted window.", {
      maxAgeMs: deps.config.requestMaxAgeMs
    });
  }

  if (!consumeNonce(deps.usedNonces, parsedRequest.nonce, context.nowMs, deps.config.nonceTtlMs)) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "replay_detected",
      httpStatus: 409
    });
    return jsonError(res, 409, "replay_detected", "Nonce already used in active window.");
  }

  const publicKeyJwk = deps.installPublicKeys.get(parsedRequest.installId);
  if (!publicKeyJwk) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "unknown_install",
      httpStatus: 401
    });
    return jsonError(res, 401, "unknown_install", "Install is not registered.");
  }

  if (!validateAuth(parsedRequest, publicKeyJwk)) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "invalid_signature",
      httpStatus: 401
    });
    return jsonError(res, 401, "invalid_auth", "Install signature verification failed.");
  }

  if (!deps.config.geminiLiveWebSocketUrl) {
    deps.logger.warn("session_init.rejected", {
      requestId,
      installIdHash,
      ipHash,
      reason: "not_ready",
      httpStatus: 503
    });
    return jsonError(res, 503, "not_ready", "Gemini Live websocket URL is not configured.");
  }

  deps.logger.info("session_init.completed", {
    requestId,
    installIdHash,
    ipHash,
    policyVersion: deps.config.policyVersion,
    model: deps.config.geminiModel,
    durationMs: deps.getNowMs() - requestStartedAtMs
  });

  return res.status(200).json(sessionInitResponse(deps.config, context.nowMs, parsedRequest.installId));
};

type InstallRegisterDeps = {
  installPublicKeys: Map<string, StoredJwk>;
  logger: AuditLogger;
};

export const createInstallRegisterHandler = (deps: InstallRegisterDeps) => (req: Request, res: Response): Response => {
  const requestId = crypto.randomUUID();
  let payload: InstallRegisterRequest;
  try {
    payload = parseRegisterRequest(req.body);
  } catch {
    deps.logger.warn("install_register.rejected", {
      requestId,
      reason: "invalid_payload",
      httpStatus: 401
    });
    return jsonError(res, 401, "invalid_auth", "Invalid registration payload.");
  }
  const installIdHash = toHashedField(payload.installId);
  if (deps.installPublicKeys.has(payload.installId)) {
    deps.logger.warn("install_register.rejected", {
      requestId,
      installIdHash,
      reason: "install_already_registered",
      httpStatus: 409
    });
    return jsonError(res, 409, "install_already_registered", "Install ID is already registered.");
  }
  deps.installPublicKeys.set(payload.installId, payload.publicKeyJwk);
  deps.logger.info("install_register.completed", {
    requestId,
    installIdHash,
    jwkKty: payload.publicKeyJwk.kty,
    jwkCrv: payload.publicKeyJwk.crv
  });
  return res.status(200).json({ ok: true });
};
