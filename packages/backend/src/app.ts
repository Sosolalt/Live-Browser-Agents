import express from "express";
import { loadConfig, type AppConfig } from "./config.js";
import { createInstallRegisterHandler, createSessionInitHandler } from "./sessionInit.js";
import { createConsoleAuditLogger, type AuditLogger } from "./logger.js";

type StoredJwk = Record<string, string | undefined>;

type CreateAppOptions = {
  config?: AppConfig;
  getNowMs?: () => number;
  logger?: AuditLogger;
};

export const createApp = (options: CreateAppOptions = {}) => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createConsoleAuditLogger();
  const app = express();
  const installPublicKeys = new Map<string, StoredJwk>();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post(
    "/api/install/register",
    createInstallRegisterHandler({
      installPublicKeys,
      logger
    })
  );

  app.post(
    "/api/session-init",
    createSessionInitHandler({
      config,
      getNowMs: options.getNowMs ?? (() => Date.now()),
      usedNonces: new Map(),
      ipRateLimitMap: new Map(),
      installRateLimitMap: new Map(),
      installPublicKeys,
      logger
    })
  );

  app.post("/api/runtime/connect", (_req, res) => {
    res.status(501).json({
      error: {
        code: "not_implemented",
        message: "Runtime transport endpoint is not implemented yet."
      }
    });
  });

  return app;
};
