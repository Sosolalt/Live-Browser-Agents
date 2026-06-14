import express from "express";
import { loadConfig, type AppConfig } from "./config.js";
import { createInstallRegisterHandler, createSessionInitHandler } from "./sessionInit.js";
import { createConsoleAuditLogger, type AuditLogger } from "./logger.js";
import { createRequireSession } from "./sessionAuth.js";
import { createOrchestratorRuntime, type OrchestratorRuntime } from "./orchestratorRuntime.js";
import { createOrchestratorRoutes } from "./orchestrateRoutes.js";

type StoredJwk = Record<string, string | undefined>;

type CreateAppOptions = {
  config?: AppConfig;
  getNowMs?: () => number;
  logger?: AuditLogger;
  orchestratorRuntime?: OrchestratorRuntime;
};

export const createApp = (options: CreateAppOptions = {}) => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createConsoleAuditLogger();
  const getNowMs = options.getNowMs ?? (() => Date.now());
  const app = express();
  const installPublicKeys = new Map<string, StoredJwk>();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

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
      getNowMs,
      usedNonces: new Map(),
      ipRateLimitMap: new Map(),
      installRateLimitMap: new Map(),
      installPublicKeys,
      logger
    })
  );

  // Phase 7/8 — autonomous orchestrator + User Knowledge Graph.
  const orchestratorRuntime = options.orchestratorRuntime ?? createOrchestratorRuntime(config, logger);
  const requireSession = createRequireSession({
    signingSecret: config.sessionCredentialSigningSecret,
    getNowMs,
    logger
  });
  app.use(createOrchestratorRoutes({ runtime: orchestratorRuntime, requireSession, logger }));

  return app;
};
