import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { toHashedField, type AuditLogger } from "./logger.js";

// Verifies the short-lived signed session credential minted by /api/session-init
// (HMAC-SHA256 over header.payload). Orchestrator and memory endpoints are gated
// by this so an install can only act on / read its own per-install data.

export interface SessionPrincipal {
  installId: string;
}

export interface AuthedRequest extends Request {
  session?: SessionPrincipal;
}

const fromBase64Url = (value: string): Buffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
};

const toBase64Url = (value: Buffer): string =>
  value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

export const verifySessionCredential = (
  token: string,
  signingSecret: string,
  nowMs: number
): SessionPrincipal | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  const expected = toBase64Url(crypto.createHmac("sha256", signingSecret).update(`${header}.${payload}`).digest());
  const providedBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return null;
  }

  let claims: { sub?: unknown; aud?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(fromBase64Url(payload).toString("utf8"));
  } catch {
    return null;
  }
  if (claims.aud !== "gemini-live") return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  return { installId: claims.sub };
};

const bearerToken = (req: Request): string | null => {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
};

export interface RequireSessionDeps {
  signingSecret: string;
  getNowMs: () => number;
  logger: AuditLogger;
}

/** Express middleware: attaches `req.session.installId` or rejects with 401. */
export const createRequireSession =
  (deps: RequireSessionDeps) =>
  (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const token = bearerToken(req);
    if (!token) {
      deps.logger.warn("auth.rejected", { reason: "missing_bearer", httpStatus: 401 });
      res.status(401).json({ error: { code: "unauthorized", message: "Missing bearer token." } });
      return;
    }
    const principal = verifySessionCredential(token, deps.signingSecret, deps.getNowMs());
    if (!principal) {
      deps.logger.warn("auth.rejected", { reason: "invalid_credential", httpStatus: 401 });
      res.status(401).json({ error: { code: "unauthorized", message: "Invalid or expired session credential." } });
      return;
    }
    req.session = principal;
    deps.logger.info("auth.accepted", { installIdHash: toHashedField(principal.installId) });
    next();
  };
