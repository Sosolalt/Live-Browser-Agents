import {
  EventBus,
  FieldCipher,
  HashEmbedder,
  InMemoryGraphStore,
  MemorySystem,
  SimulatedActionExecutor,
  createPostgresGraphStore,
  defaultPolicy,
  runOrchestration
} from "@gemini-hackaton/orchestrator";
import type {
  ActionExecutor,
  DomSnapshot,
  GraphStore,
  MemoryAuditEvent,
  OrchestratorPolicy,
  RunInput,
  RunOutcome,
  SessionBudget
} from "@gemini-hackaton/orchestrator";
import type { AppConfig } from "./config.js";
import { toHashedField, type AuditLogger } from "./logger.js";

export interface OrchestratorRuntime {
  memory: MemorySystem;
  eventBus: EventBus;
  policy: OrchestratorPolicy;
  budget: SessionBudget;
  createExecutor: (snapshot?: DomSnapshot) => ActionExecutor;
  run: (input: RunInput & { snapshot?: DomSnapshot }) => Promise<RunOutcome>;
}

export interface OrchestratorRuntimeOverrides {
  store?: GraphStore;
  memory?: MemorySystem;
  eventBus?: EventBus;
  clock?: () => number;
  newId?: () => string;
}

/**
 * Constructs the backend-side orchestration runtime: a shared MemorySystem
 * (Postgres+pgvector when DATABASE_URL is set, else in-memory), an EventBus for
 * observability, and a runner. The ActionExecutor is the SimulatedActionExecutor
 * seeded from the request snapshot; production swaps in a live executor that
 * dispatches AgentActions to the extension over the existing transport.
 */
export const createOrchestratorRuntime = (
  config: AppConfig,
  logger: AuditLogger,
  overrides: OrchestratorRuntimeOverrides = {}
): OrchestratorRuntime => {
  const clock = overrides.clock ?? (() => Date.now());
  const newId = overrides.newId;

  const audit = (event: MemoryAuditEvent): void => {
    logger.info("memory.audit", {
      kind: event.type,
      installIdHash: toHashedField(event.installId),
      ...("returnedNodeIds" in event ? { returnedNodes: event.returnedNodeIds.length } : {}),
      ...("removed" in event ? { removed: event.removed } : {}),
      ...("paused" in event ? { paused: event.paused } : {})
    });
  };

  const store: GraphStore =
    overrides.store ??
    (config.databaseUrl
      ? createPostgresGraphStore(config.databaseUrl, { dimensions: config.embeddingDimensions })
      : new InMemoryGraphStore());

  const memory =
    overrides.memory ??
    new MemorySystem({
      store,
      embedder: new HashEmbedder(config.embeddingDimensions),
      cipher: FieldCipher.fromSecret(config.memoryEncryptionKey),
      audit,
      clock,
      ...(newId ? { newId } : {})
    });

  const eventBus = overrides.eventBus ?? new EventBus();
  const policy = defaultPolicy({ policyVersion: config.policyVersion, blockedDomains: config.blockedDomains });
  const budget: SessionBudget = {
    maxSteps: config.orchestratorMaxSteps,
    maxToolCalls: config.orchestratorMaxToolCalls,
    maxCostMicros: config.orchestratorMaxCostMicros
  };

  const createExecutor = (snapshot?: DomSnapshot): ActionExecutor =>
    new SimulatedActionExecutor(
      snapshot
        ? { url: snapshot.url, title: snapshot.title, elements: snapshot.elements, text: snapshot.text }
        : {}
    );

  const run = (input: RunInput & { snapshot?: DomSnapshot }): Promise<RunOutcome> =>
    runOrchestration(
      {
        executor: createExecutor(input.snapshot),
        memory,
        eventBus,
        policy,
        clock,
        ...(newId ? { newId } : {})
      },
      {
        installId: input.installId,
        sessionId: input.sessionId,
        intent: input.intent,
        budget: { ...budget, ...input.budget },
        ...(input.runId ? { runId: input.runId } : {})
      }
    );

  return { memory, eventBus, policy, budget, createExecutor, run };
};
