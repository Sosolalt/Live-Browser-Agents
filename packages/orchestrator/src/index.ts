// @gemini-hackaton/orchestrator — backend-only autonomous multi-agent
// orchestration (Phase 7) over a per-install User Knowledge Graph (Phase 8).
// No LangChain/LangGraph types are required by consumers of this barrel beyond
// the optional checkpointer; the graph is driven via runOrchestration().

// Domain types
export * from "./types.js";
export * from "./events.js";

// Ports
export * from "./ports/embedder.js";
export * from "./ports/chatModel.js";
export * from "./ports/actionExecutor.js";

// Phase 8 — User Knowledge Graph
export * from "./memory/kgTypes.js";
export * from "./memory/crypto.js";
export * from "./memory/pii.js";
export * from "./memory/graphStore.js";
export { InMemoryGraphStore } from "./memory/inMemoryGraphStore.js";
export { PostgresGraphStore, createPostgresGraphStore } from "./memory/postgresGraphStore.js";
export type { PostgresGraphStoreOptions } from "./memory/postgresGraphStore.js";
export * from "./memory/writer.js";
export * from "./memory/retriever.js";
export * from "./memory/consolidation.js";
export * from "./memory/memorySystem.js";

// Phase 7 — Orchestration graph
export * from "./graph/policy.js";
export { OrchestratorState, currentTask } from "./graph/state.js";
export type { OrchestratorStateType, ActionRecord, Phase } from "./graph/state.js";
export type { NodeDeps, NodeEmit } from "./graph/nodes.js";
export { buildGraph } from "./graph/build.js";
export { runOrchestration } from "./graph/run.js";
export type { OrchestratorConfig, RunInput, RunOutcome } from "./graph/run.js";
