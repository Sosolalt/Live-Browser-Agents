import crypto from "node:crypto";
import { GraphRecursionError, MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { ActionExecutor } from "../ports/actionExecutor.js";
import type { ChatModelRouter } from "../ports/chatModel.js";
import { StaticChatModelRouter } from "../ports/chatModel.js";
import type { MemorySystem } from "../memory/memorySystem.js";
import type { EventBus, OrchestratorEvent, OrchestratorEventType } from "../events.js";
import type { AgentName, RunStatus, SessionBudget, Task, TerminationReason } from "../types.js";
import { buildGraph } from "./build.js";
import type { NodeDeps } from "./nodes.js";
import { defaultPolicy } from "./policy.js";
import type { OrchestratorPolicy } from "./policy.js";
import type { ActionRecord, OrchestratorStateType } from "./state.js";

export interface OrchestratorConfig {
  executor: ActionExecutor;
  memory: MemorySystem;
  chatModel?: ChatModelRouter;
  policy?: OrchestratorPolicy;
  clock?: () => number;
  newId?: () => string;
  eventBus?: EventBus;
  checkpointer?: BaseCheckpointSaver;
  maxAttempts?: number;
}

export interface RunInput {
  installId: string;
  sessionId: string;
  intent: string;
  runId?: string;
  budget?: Partial<SessionBudget>;
}

export interface RunOutcome {
  runId: string;
  installId: string;
  sessionId: string;
  status: RunStatus;
  terminationReason: TerminationReason | null;
  steps: number;
  toolCalls: number;
  tasks: Task[];
  actions: ActionRecord[];
  scratchpad: string[];
  events: OrchestratorEvent[];
}

const DEFAULT_BUDGET: SessionBudget = { maxSteps: 12, maxToolCalls: 24, maxCostMicros: 5_000_000 };

/**
 * Runs the autonomous orchestration graph end to end. Emits node-level events to
 * the provided EventBus (and returns them) for observability. Per-session
 * checkpointing is keyed by sessionId so a reconnecting run resumes the graph.
 */
export const runOrchestration = async (config: OrchestratorConfig, input: RunInput): Promise<RunOutcome> => {
  const clock = config.clock ?? (() => Date.now());
  const newId = config.newId ?? (() => crypto.randomUUID());
  const runId = input.runId ?? newId();
  const events: OrchestratorEvent[] = [];

  const publish = (type: OrchestratorEventType, node?: AgentName, data?: Record<string, unknown>): void => {
    const event: OrchestratorEvent = {
      type,
      runId,
      installId: input.installId,
      sessionId: input.sessionId,
      ts: clock(),
      ...(node ? { node } : {}),
      ...(data ? { data } : {})
    };
    events.push(event);
    config.eventBus?.publish(event);
  };

  const deps: NodeDeps = {
    chatModel: config.chatModel ?? new StaticChatModelRouter(),
    executor: config.executor,
    memory: config.memory,
    policy: config.policy ?? defaultPolicy(),
    emit: (type, node, data) => publish(type, node, data),
    clock,
    newId,
    ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {})
  };

  const checkpointer = config.checkpointer ?? new MemorySaver();
  const graph = buildGraph(deps, checkpointer);

  const budget: SessionBudget = { ...DEFAULT_BUDGET, ...input.budget };
  const initialState = {
    installId: input.installId,
    sessionId: input.sessionId,
    runId,
    intent: input.intent,
    budget
  };
  // Backstop recursion limit well above the planner's self-enforced step budget.
  const recursionLimit = budget.maxSteps * 8 + 20;

  publish("run_started", undefined, { intent: input.intent });

  let finalState: OrchestratorStateType | null = null;
  try {
    finalState = (await graph.invoke(initialState, {
      configurable: { thread_id: input.sessionId },
      recursionLimit
    })) as OrchestratorStateType;
  } catch (error) {
    if (error instanceof GraphRecursionError) {
      publish("budget_exhausted", undefined, { reason: "recursion_limit" });
    } else {
      publish("error", undefined, { message: error instanceof Error ? error.message : String(error) });
      throw augment(error, runId);
    }
  }

  const status: RunStatus = finalState?.status ?? "terminated";
  const terminationReason: TerminationReason | null =
    finalState?.terminationReason ?? (finalState ? "completed" : "budget_steps");

  publish("run_finished", undefined, { status, terminationReason });

  return {
    runId,
    installId: input.installId,
    sessionId: input.sessionId,
    status,
    terminationReason,
    steps: finalState?.usage.steps ?? 0,
    toolCalls: finalState?.usage.toolCalls ?? 0,
    tasks: finalState?.plan.tasks ?? [],
    actions: finalState?.actionsTaken ?? [],
    scratchpad: finalState?.scratchpad ?? [],
    events
  };
};

const augment = (error: unknown, runId: string): Error => {
  if (error instanceof Error) {
    error.message = `[run ${runId}] ${error.message}`;
    return error;
  }
  return new Error(`[run ${runId}] ${String(error)}`);
};
