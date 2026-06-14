import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { AuditLogger } from "./logger.js";
import { toHashedField } from "./logger.js";
import type { AuthedRequest } from "./sessionAuth.js";
import type { OrchestratorRuntime } from "./orchestratorRuntime.js";

const snapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  elements: z.array(z.object({ selector: z.string(), role: z.string(), label: z.string(), confidence: z.number() })),
  text: z.string()
});

const budgetSchema = z
  .object({
    maxSteps: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
    maxCostMicros: z.number().int().positive().optional()
  })
  .optional();

const orchestrateSchema = z.object({
  sessionId: z.string().min(1).max(128),
  intent: z.string().min(1).max(2000),
  snapshot: snapshotSchema.optional(),
  budget: budgetSchema
});

const forgetSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("node"), nodeId: z.string().min(1) }),
    z.object({ kind: z.literal("edge"), edgeId: z.string().min(1) }),
    z.object({ kind: z.literal("domain"), domain: z.string().min(1) }),
    z.object({ kind: z.literal("timeRange"), from: z.number(), to: z.number() })
  ])
});

const exportSchema = z.object({ unseal: z.boolean().optional() }).optional();
const pauseSchema = z.object({ paused: z.boolean() });

const badRequest = (res: Response, message: string): Response =>
  res.status(400).json({ error: { code: "invalid_request", message } });

export interface OrchestratorRoutesDeps {
  runtime: OrchestratorRuntime;
  requireSession: RequestHandler;
  logger: AuditLogger;
}

export const createOrchestratorRoutes = (deps: OrchestratorRoutesDeps): Router => {
  const router = Router();
  const { runtime, requireSession, logger } = deps;

  // Run the autonomous graph for the authenticated install.
  router.post("/api/orchestrate", requireSession, (req: AuthedRequest, res) => {
    const installId = req.session?.installId;
    if (!installId) return badRequest(res, "Missing session.");
    const parsed = orchestrateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "Invalid orchestrate payload.");

    void runtime
      .run({
        installId,
        sessionId: parsed.data.sessionId,
        intent: parsed.data.intent,
        ...(parsed.data.snapshot ? { snapshot: parsed.data.snapshot } : {}),
        ...(parsed.data.budget ? { budget: parsed.data.budget } : {})
      })
      .then((outcome) => {
        logger.info("orchestrate.completed", {
          installIdHash: toHashedField(installId),
          runId: outcome.runId,
          status: outcome.status,
          terminationReason: outcome.terminationReason,
          steps: outcome.steps
        });
        res.status(200).json({
          runId: outcome.runId,
          status: outcome.status,
          terminationReason: outcome.terminationReason,
          steps: outcome.steps,
          toolCalls: outcome.toolCalls,
          tasks: outcome.tasks.map((task) => ({
            id: task.id,
            agent: task.agent,
            status: task.status,
            blastRadius: task.blastRadius,
            approvals: task.approvals
          })),
          actionCount: outcome.actions.length,
          scratchpad: outcome.scratchpad,
          events: outcome.events
        });
      })
      .catch((error: unknown) => {
        logger.warn("orchestrate.failed", {
          installIdHash: toHashedField(installId),
          message: error instanceof Error ? error.message : String(error)
        });
        res.status(500).json({ error: { code: "orchestration_failed", message: "Orchestration run failed." } });
      });
  });

  // Replay (and, for an in-flight run, stream) node-level events via SSE.
  router.get("/api/orchestrate/:runId/events", requireSession, (req: AuthedRequest, res) => {
    const installId = req.session?.installId;
    if (!installId) return badRequest(res, "Missing session.");
    const { runId } = req.params;
    const history = runtime.eventBus.getHistory(runId);
    if (history.length === 0) {
      return res.status(404).json({ error: { code: "not_found", message: "Unknown run." } });
    }
    if (history[0].installId !== installId) {
      return res.status(403).json({ error: { code: "forbidden", message: "Run belongs to another install." } });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    for (const event of history) {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (runtime.eventBus.isFinished(runId)) {
      res.end();
      return;
    }
    const unsubscribe = runtime.eventBus.subscribe(runId, (event) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "run_finished" || event.type === "error") {
        unsubscribe();
        res.end();
      }
    });
    req.on("close", unsubscribe);
  });

  // Full export of the install's knowledge graph (optionally unsealing PII).
  router.post("/api/memory/export", requireSession, (req: AuthedRequest, res) => {
    const installId = req.session?.installId;
    if (!installId) return badRequest(res, "Missing session.");
    const parsed = exportSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, "Invalid export payload.");
    void runtime.memory
      .export(installId, { unseal: parsed.data?.unseal ?? false })
      .then((bundle) => res.status(200).json(bundle))
      .catch(() => res.status(500).json({ error: { code: "export_failed", message: "Export failed." } }));
  });

  // Cascading forget by node / edge / domain / time-range.
  router.post("/api/memory/forget", requireSession, (req: AuthedRequest, res) => {
    const installId = req.session?.installId;
    if (!installId) return badRequest(res, "Missing session.");
    const parsed = forgetSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "Invalid forget payload.");
    void runtime.memory
      .forget(installId, parsed.data.scope)
      .then((result) => {
        logger.info("memory.forget", { installIdHash: toHashedField(installId), scope: parsed.data.scope.kind, removed: result.removed });
        res.status(200).json(result);
      })
      .catch(() => res.status(500).json({ error: { code: "forget_failed", message: "Forget failed." } }));
  });

  // Pause / resume recording for the install.
  router.post("/api/memory/pause", requireSession, (req: AuthedRequest, res) => {
    const installId = req.session?.installId;
    if (!installId) return badRequest(res, "Missing session.");
    const parsed = pauseSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, "Invalid pause payload.");
    runtime.memory.setPaused(installId, parsed.data.paused);
    res.status(200).json({ paused: parsed.data.paused });
  });

  // Read-only typed subgraph for the popup observability view.
  router.get("/api/memory/graph", requireSession, (req: AuthedRequest, res) => {
    const installId = req.session?.installId;
    if (!installId) return badRequest(res, "Missing session.");
    void runtime.memory
      .export(installId)
      .then((bundle) =>
        res.status(200).json({
          nodes: bundle.nodes.map((node) => ({
            id: node.id,
            type: node.type,
            label: node.label,
            importance: node.importance,
            tier: node.tier
          })),
          edges: bundle.edges.map((edge) => ({ id: edge.id, type: edge.type, from: edge.from, to: edge.to, weight: edge.weight })),
          paused: runtime.memory.isPaused(installId)
        })
      )
      .catch(() => res.status(500).json({ error: { code: "graph_failed", message: "Graph read failed." } }));
  });

  return router;
};
