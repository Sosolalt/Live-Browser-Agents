import { Annotation } from "@langchain/langgraph";
import type { MemoryEvent } from "../memory/kgTypes.js";
import type {
  ActionResult,
  AgentAction,
  CriticDecision,
  DomSnapshot,
  Plan,
  ResearchResult,
  RunStatus,
  SessionBudget,
  Task,
  TerminationReason,
  VerifierResult
} from "../types.js";

export type Phase = "start" | "act" | "done";

export interface ActionRecord {
  action: AgentAction;
  result: ActionResult;
}

const lastWins = <T>(): { reducer: (current: T, update: T) => T } => ({
  reducer: (_current: T, update: T) => update
});

const appendList = <T>(): { reducer: (current: T[], update: T[]) => T[]; default: () => T[] } => ({
  reducer: (current: T[], update: T[]) => current.concat(update),
  default: () => []
});

/**
 * Shared typed state threaded through every node (LangGraph supervisor pattern).
 * Append-only channels (scratchpad, actionsTaken, memoryEvents) use concat
 * reducers so parallel nodes can contribute without clobbering each other.
 */
export const OrchestratorState = Annotation.Root({
  installId: Annotation<string>(),
  sessionId: Annotation<string>(),
  runId: Annotation<string>(),
  intent: Annotation<string>(),
  phase: Annotation<Phase>({ reducer: (_c, u) => u, default: () => "start" }),
  domSnapshot: Annotation<DomSnapshot | null>({ reducer: (c, u) => u ?? c, default: () => null }),
  research: Annotation<ResearchResult | null>({ reducer: (c, u) => u ?? c, default: () => null }),
  plan: Annotation<Plan>({ reducer: (_c, u) => u, default: () => ({ tasks: [], cursor: 0 }) }),
  scratchpad: Annotation<string[]>(appendList<string>()),
  actionsTaken: Annotation<ActionRecord[]>(appendList<ActionRecord>()),
  lastActionResult: Annotation<ActionResult | null>({ reducer: (c, u) => u ?? c, default: () => null }),
  verifierResult: Annotation<VerifierResult | null>({ reducer: (_c, u) => u, default: () => null }),
  criticDecision: Annotation<CriticDecision | null>({ reducer: (_c, u) => u, default: () => null }),
  memoryEvents: Annotation<MemoryEvent[]>(appendList<MemoryEvent>()),
  budget: Annotation<SessionBudget>({
    ...lastWins<SessionBudget>(),
    default: () => ({ maxSteps: 12, maxToolCalls: 24, maxCostMicros: 5_000_000 })
  }),
  usage: Annotation<{ steps: number; toolCalls: number; costMicros: number }>({
    reducer: (_c, u) => u,
    default: () => ({ steps: 0, toolCalls: 0, costMicros: 0 })
  }),
  status: Annotation<RunStatus>({ reducer: (_c, u) => u, default: () => "running" }),
  terminationReason: Annotation<TerminationReason | null>({ reducer: (_c, u) => u, default: () => null }),
  needsReplan: Annotation<boolean>({ reducer: (_c, u) => u, default: () => false }),
  anomaly: Annotation<boolean>({ reducer: (_c, u) => u, default: () => false })
});

export type OrchestratorStateType = typeof OrchestratorState.State;
export type OrchestratorUpdate = typeof OrchestratorState.Update;

export const currentTask = (state: OrchestratorStateType): Task | null => {
  const { tasks, cursor } = state.plan;
  return cursor >= 0 && cursor < tasks.length ? tasks[cursor] : null;
};
