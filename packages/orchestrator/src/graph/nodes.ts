import type { ChatModelRouter } from "../ports/chatModel.js";
import { generateStructured } from "../ports/chatModel.js";
import type { ActionExecutor } from "../ports/actionExecutor.js";
import type { MemorySystem } from "../memory/memorySystem.js";
import type { MemoryEvent } from "../memory/kgTypes.js";
import type { OrchestratorEventType } from "../events.js";
import { z } from "zod";
import type {
  AgentAction,
  AgentName,
  CriticDecision,
  DomSnapshot,
  ResearchResult,
  Task,
  VerifierResult,
  WorkerAgent
} from "../types.js";
import type { OrchestratorPolicy } from "./policy.js";
import { classifyBlastRadius, feasibilityPrecheck, isBlockedDomain, isDestructive } from "./policy.js";
import type { OrchestratorStateType, Phase } from "./state.js";
import { currentTask } from "./state.js";

export type NodeEmit = (type: OrchestratorEventType, node: AgentName, data?: Record<string, unknown>) => void;

export interface NodeDeps {
  chatModel: ChatModelRouter;
  executor: ActionExecutor;
  memory: MemorySystem;
  policy: OrchestratorPolicy;
  emit: NodeEmit;
  clock: () => number;
  newId: () => string;
  maxAttempts?: number;
}

type Update = Partial<OrchestratorStateType>;
type Node = (state: OrchestratorStateType) => Promise<Update>;

const TOOL_CALL_COST_MICROS = 1000;
const MODEL_CALL_COST_MICROS = 500;

// --- Perception ---------------------------------------------------------------

export const perceptionNode = (deps: NodeDeps): Node => async (state) => {
  deps.emit("node_started", "perception");
  const snapshot = await deps.executor.snapshot();
  // Semantic tagging on the cheap (flash) tier — enriches element labels.
  const tagged = await semanticTags(deps, snapshot);
  const anomaly = isBlockedDomain(deps.policy, snapshot.url);
  deps.emit("node_finished", "perception", { url: snapshot.url, elements: tagged.elements.length, anomaly });
  return {
    domSnapshot: tagged,
    scratchpad: [`perception: ${tagged.elements.length} interactive elements on ${tagged.url}`],
    ...(anomaly ? { anomaly: true } : {})
  };
};

const semanticTags = async (deps: NodeDeps, snapshot: DomSnapshot): Promise<DomSnapshot> => {
  const schema = z.object({
    tags: z.array(z.object({ selector: z.string(), role: z.string(), label: z.string() }))
  });
  try {
    const result = await generateStructured(
      deps.chatModel.forTier("flash"),
      [
        { role: "system", content: "DIRECTIVE: semantic_tags\nTag interactive elements with role and label." },
        { role: "user", content: JSON.stringify({ elements: snapshot.elements }) }
      ],
      schema
    );
    const bySelector = new Map(result.tags.map((tag) => [tag.selector, tag]));
    return {
      ...snapshot,
      elements: snapshot.elements.map((element) => {
        const tag = bySelector.get(element.selector);
        return tag ? { ...element, role: tag.role, label: tag.label } : element;
      })
    };
  } catch {
    return snapshot;
  }
};

// --- Researcher (RAG) ---------------------------------------------------------

export const researcherNode = (deps: NodeDeps): Node => async (state) => {
  deps.emit("node_started", "researcher");
  const subgraph = await deps.memory.retrieve({
    installId: state.installId,
    query: state.intent,
    profile: "researcher",
    agent: "researcher",
    maxNodes: 8
  });
  const facts = subgraph.nodes.map((node) => node.label);
  const schema = z.object({ summary: z.string() });
  let summary = `No prior knowledge for "${state.intent}".`;
  try {
    const result = await generateStructured(
      deps.chatModel.forTier("pro"),
      [
        { role: "system", content: "DIRECTIVE: research\nGround the answer in prior facts when available." },
        { role: "user", content: JSON.stringify({ query: state.intent, facts }) }
      ],
      schema
    );
    summary = result.summary;
  } catch {
    // keep default summary
  }
  const research: ResearchResult = {
    summary,
    citations: facts.slice(0, 5),
    groundingNodeIds: subgraph.nodes.map((node) => node.id)
  };
  deps.emit("node_finished", "researcher", { groundingNodes: research.groundingNodeIds.length });
  return { research, scratchpad: [`researcher: grounded on ${facts.length} fact(s)`] };
};

// --- Planner (supervisor) -----------------------------------------------------

export const plannerNode = (deps: NodeDeps): Node => async (state) => {
  if (state.status !== "running") {
    return { phase: "done" satisfies Phase };
  }
  deps.emit("node_started", "planner");
  const usage = { ...state.usage, steps: state.usage.steps + 1 };

  if (state.anomaly) {
    deps.emit("budget_exhausted", "planner", { reason: "anomaly" });
    return terminate(usage, "anomaly");
  }
  const budgetStop = checkBudget(state, usage);
  if (budgetStop) {
    deps.emit("budget_exhausted", "planner", { reason: budgetStop });
    return terminate(usage, budgetStop);
  }

  // First entry after perception+research join: build the task DAG.
  if (state.phase === "start") {
    const tasks = await buildPlan(deps, state);
    deps.emit("plan_created", "planner", { tasks: tasks.length });
    if (tasks.length === 0) {
      return { ...terminate(usage, "no_plan"), plan: { tasks, cursor: 0 } };
    }
    const cursor = firstPendingIndex(tasks);
    return {
      usage,
      plan: { tasks, cursor },
      phase: "act" satisfies Phase,
      scratchpad: [`planner: decomposed intent into ${tasks.length} task(s)`]
    };
  }

  // Re-entry: advance the loop (handle replan/retry or move to the next task).
  const tasks = state.plan.tasks.map((task) => ({ ...task }));
  const maxAttempts = deps.maxAttempts ?? 2;
  if (state.needsReplan && state.verifierResult) {
    const failed = tasks.find((task) => task.id === state.verifierResult?.taskId);
    if (failed) {
      failed.attempts += 1;
      if (failed.attempts < maxAttempts && feasibilityPrecheck(failed, state.domSnapshot)) {
        failed.status = "pending";
        deps.emit("node_finished", "planner", { replan: "retry", task: failed.id });
      } else {
        failed.status = "failed";
        deps.emit("node_finished", "planner", { replan: "give_up", task: failed.id });
      }
    }
  }

  const cursor = firstPendingIndex(tasks);
  if (cursor < 0) {
    return { usage, plan: { tasks, cursor: 0 }, needsReplan: false, ...terminate(usage, "completed") };
  }
  return { usage, plan: { tasks, cursor }, phase: "act" satisfies Phase, needsReplan: false };
};

// --- Critic / guardrail (with quorum) -----------------------------------------

export const criticNode = (deps: NodeDeps): Node => async (state) => {
  const task = currentTask(state);
  if (!task) return {};
  deps.emit("node_started", "critic");

  const blastRadius = max3(task.blastRadius, classifyBlastRadius(deps.policy, task.action));
  const targetUrl = task.action.kind === "navigate" ? task.action.target : state.domSnapshot?.url;
  const reasons: string[] = [];

  const blocked = isBlockedDomain(deps.policy, targetUrl);
  if (blocked) reasons.push("blocked_domain");
  const criticVote = !blocked;

  let quorumRequired = false;
  let approved = criticVote;
  const tasks = state.plan.tasks.map((t) => ({ ...t }));
  const target = tasks[state.plan.cursor];
  target.blastRadius = blastRadius;
  target.approvals = { ...target.approvals, critic: criticVote };

  if (blastRadius === "high") {
    quorumRequired = true;
    const verifierVote = feasibilityPrecheck(target, state.domSnapshot);
    target.approvals.verifier = verifierVote;
    // Planner vote was set when the task was admitted to the plan.
    approved = target.approvals.planner && criticVote && verifierVote;
    if (!verifierVote) reasons.push("verifier_precheck_failed");
    if (!target.approvals.planner) reasons.push("planner_did_not_approve");
    deps.emit("quorum_decision", "critic", {
      task: target.id,
      planner: target.approvals.planner,
      critic: criticVote,
      verifier: verifierVote,
      approved
    });
  }

  const decision: CriticDecision = { taskId: target.id, approved, blastRadius, reasons, quorumRequired };
  deps.emit("critic_decision", "critic", { ...decision });

  if (approved) {
    return { criticDecision: decision, plan: { ...state.plan, tasks } };
  }

  // Hard policy stops terminate the run; soft vetoes skip the task and reroute.
  if (blocked) {
    target.status = "skipped";
    return { criticDecision: decision, plan: { ...state.plan, tasks }, status: "terminated", terminationReason: "critic_veto" };
  }
  if (quorumRequired) {
    target.status = "skipped";
    return {
      criticDecision: decision,
      plan: { ...state.plan, tasks },
      status: "terminated",
      terminationReason: "quorum_failed"
    };
  }
  target.status = "skipped";
  return { criticDecision: decision, plan: { ...state.plan, tasks }, scratchpad: [`critic: skipped ${target.id}`] };
};

// --- Workers: Navigator / Form / Extractor ------------------------------------

export const workerNode = (agent: WorkerAgent, deps: NodeDeps): Node => async (state) => {
  const task = currentTask(state);
  if (!task) return {};
  deps.emit("node_started", agent);
  deps.emit("action_dispatched", agent, { action: task.action.kind, target: task.action.target });

  const result = await deps.executor.execute(task.action);
  const usage = {
    ...state.usage,
    toolCalls: state.usage.toolCalls + 1,
    costMicros: state.usage.costMicros + TOOL_CALL_COST_MICROS + MODEL_CALL_COST_MICROS
  };

  const tasks = state.plan.tasks.map((t) => ({ ...t }));
  tasks[state.plan.cursor].status = "running";

  deps.emit("action_result", agent, { ok: result.ok, observation: result.observation });
  return {
    usage,
    lastActionResult: result,
    actionsTaken: [{ action: task.action, result }],
    plan: { ...state.plan, tasks },
    scratchpad: [`${agent}: ${result.observation}`]
  };
};

// --- Verifier (post-state check, rollback, anomaly) ---------------------------

export const verifierNode = (deps: NodeDeps): Node => async (state) => {
  const task = currentTask(state);
  const result = state.lastActionResult;
  if (!task || !result) return {};
  deps.emit("node_started", "verifier");

  const redirectedToBlocked = isBlockedDomain(deps.policy, asString(result.postState?.url));
  const passed = result.ok && expectationMet(task, result) && !redirectedToBlocked;
  const anomaly = redirectedToBlocked;

  const tasks = state.plan.tasks.map((t) => ({ ...t }));
  const target = tasks[state.plan.cursor];

  if (passed) {
    target.status = "done";
    const verifierResult: VerifierResult = { taskId: task.id, passed: true, reason: "post-state matched", rollback: false, anomaly: false };
    deps.emit("verifier_result", "verifier", { ...verifierResult });
    return { plan: { ...state.plan, tasks }, verifierResult };
  }

  // Diverged: roll back the last action when it is reversible.
  let rolledBack = false;
  if (result.reversible && result.undo) {
    await deps.executor.execute(result.undo);
    rolledBack = true;
  }
  target.status = "failed";
  const verifierResult: VerifierResult = {
    taskId: task.id,
    passed: false,
    reason: anomaly ? "anomalous redirect" : "post-state diverged",
    rollback: rolledBack,
    anomaly
  };
  deps.emit("verifier_result", "verifier", { ...verifierResult, rolledBack });
  if (anomaly) deps.emit("anomaly_detected", "verifier", { url: asString(result.postState?.url) });
  return {
    plan: { ...state.plan, tasks },
    verifierResult,
    needsReplan: true,
    ...(anomaly ? { anomaly: true } : {})
  };
};

// --- Memory (write path owner) ------------------------------------------------

export const memoryNode = (deps: NodeDeps): Node => async (state) => {
  const task = currentTask(state);
  deps.emit("node_started", "memory");
  const events = buildMemoryEvents(deps, state, task);
  await deps.memory.recordEvents(events);
  deps.emit("memory_write", "memory", { events: events.length });
  return { memoryEvents: events };
};

// --- Helpers ------------------------------------------------------------------

const terminate = (
  usage: OrchestratorStateType["usage"],
  reason: OrchestratorStateType["terminationReason"]
): Update => ({
  usage,
  status: reason === "completed" ? "done" : "terminated",
  terminationReason: reason,
  phase: "done" satisfies Phase
});

const checkBudget = (
  state: OrchestratorStateType,
  usage: OrchestratorStateType["usage"]
): OrchestratorStateType["terminationReason"] | null => {
  if (usage.steps > state.budget.maxSteps) return "budget_steps";
  if (usage.toolCalls > state.budget.maxToolCalls) return "budget_tool_calls";
  if (usage.costMicros > state.budget.maxCostMicros) return "budget_cost";
  return null;
};

const firstPendingIndex = (tasks: Task[]): number => tasks.findIndex((task) => task.status === "pending");

const expectationMet = (task: Task, result: { postState?: Record<string, unknown> }): boolean => {
  const expected = task.expected.toLowerCase();
  const post = result.postState ?? {};
  if (expected.includes("submitted")) return post.submitted === true;
  if (expected.includes("navigated") || expected.startsWith("url")) {
    return typeof post.url === "string" && (task.action.target ? post.url.includes(hostFragment(task.action.target)) : true);
  }
  if (expected.includes("filled")) {
    const fields = (post.fields ?? {}) as Record<string, unknown>;
    return task.action.target ? task.action.target in fields : Object.keys(fields).length > 0;
  }
  if (expected.includes("extract")) return typeof post.extracted === "string";
  return true;
};

const hostFragment = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const buildMemoryEvents = (deps: NodeDeps, state: OrchestratorStateType, task: Task | null): MemoryEvent[] => {
  const base = { installId: state.installId, sessionId: state.sessionId, ts: deps.clock() };
  const events: MemoryEvent[] = [
    { ...base, kind: "session_started", source: "memory", payload: { sessionId: state.sessionId } },
    { ...base, kind: "intent_captured", source: "planner", payload: { text: state.intent } }
  ];
  if (state.domSnapshot) {
    events.push({
      ...base,
      kind: "page_visited",
      source: "perception",
      payload: { url: state.domSnapshot.url, title: state.domSnapshot.title, text: state.domSnapshot.text }
    });
  }
  if (task) {
    events.push({
      ...base,
      kind: "task_planned",
      source: "planner",
      payload: { taskId: task.id, description: task.description, status: task.status }
    });
    if (state.lastActionResult) {
      events.push({
        ...base,
        kind: "action_taken",
        source: task.agent,
        payload: {
          kind: task.action.kind,
          target: task.action.target,
          ok: state.lastActionResult.ok,
          observation: state.lastActionResult.observation,
          summary: `${task.action.kind} ${task.action.target ?? ""}`.trim()
        }
      });
    }
    if (task.status === "failed") {
      events.push({
        ...base,
        kind: "failure",
        source: "verifier",
        payload: { reason: state.verifierResult?.reason ?? "task failed", taskId: task.id }
      });
    }
    if (task.status === "done") {
      events.push({ ...base, kind: "skill_candidate", source: "planner", payload: { skill: task.description } });
    }
  }
  return events;
};

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const max3 = (a: Task["blastRadius"], b: Task["blastRadius"]): Task["blastRadius"] => {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
};

// --- Planner decomposition ----------------------------------------------------

const buildPlan = async (deps: NodeDeps, state: OrchestratorStateType): Promise<Task[]> => {
  // Reuse a learned Skill if the planner's procedural memory matches the intent.
  const procedural = await deps.memory.retrieve({
    installId: state.installId,
    query: state.intent,
    profile: "planner",
    agent: "planner",
    maxNodes: 5
  });
  const skillHit = procedural.nodes.find((node) => node.type === "Skill");
  const tasks = decomposeIntent(deps, state.intent, state.domSnapshot);
  if (skillHit) {
    tasks.unshift(
      makeTask(deps, "extractor", `apply skill: ${skillHit.label}`, {
        id: deps.newId(),
        kind: "extract",
        target: state.domSnapshot?.url,
        rationale: `reuse skill ${skillHit.id}`,
        blastRadius: "low"
      })
    );
  }
  return tasks;
};

const selectorForRole = (snapshot: DomSnapshot | null, role: string): string | undefined =>
  snapshot?.elements.find((element) => element.role === role)?.selector;

const decomposeIntent = (deps: NodeDeps, intent: string, snapshot: DomSnapshot | null): Task[] => {
  const lower = intent.toLowerCase();
  const tasks: Task[] = [];
  const urlMatch = /https?:\/\/[^\s'"]+/.exec(intent);

  if (urlMatch) {
    tasks.push(
      makeTask(deps, "navigator", `navigate to ${urlMatch[0]}`, {
        id: deps.newId(),
        kind: "navigate",
        target: urlMatch[0],
        blastRadius: "medium"
      })
    );
  }
  if (/\b(search|find|look up|lookup)\b/.test(lower)) {
    const query = intent.replace(/.*\b(search|find|look up|lookup)\b(\s+for)?/i, "").trim() || intent;
    tasks.push(
      makeTask(deps, "form", `search for ${query}`, {
        id: deps.newId(),
        kind: "fill",
        target: selectorForRole(snapshot, "textbox") ?? "#search",
        value: query,
        blastRadius: "low"
      })
    );
    tasks.push(
      makeTask(deps, "navigator", "submit search", {
        id: deps.newId(),
        kind: "click",
        target: selectorForRole(snapshot, "button") ?? "#submit",
        blastRadius: "low"
      })
    );
  }
  if (/\b(fill|sign up|register|book|apply|enter)\b/.test(lower) && !tasks.some((task) => task.action.kind === "fill")) {
    tasks.push(
      makeTask(deps, "form", "fill the form", {
        id: deps.newId(),
        kind: "fill",
        target: selectorForRole(snapshot, "textbox") ?? "#field",
        value: "auto",
        blastRadius: "medium"
      })
    );
  }
  if (/\b(buy|purchase|checkout|pay|order|submit|confirm)\b/.test(lower)) {
    tasks.push(
      makeTask(deps, "form", "submit / confirm", {
        id: deps.newId(),
        kind: "submit",
        target: selectorForRole(snapshot, "button") ?? "#submit",
        blastRadius: "high"
      })
    );
  }
  if (/\b(extract|get|read|scrape|summar|collect|list)\b/.test(lower) || tasks.length === 0) {
    tasks.push(
      makeTask(deps, "extractor", "extract page content", {
        id: deps.newId(),
        kind: "extract",
        target: snapshot?.url,
        blastRadius: "low"
      })
    );
  }
  return tasks;
};

const makeTask = (deps: NodeDeps, agent: WorkerAgent, description: string, action: AgentAction): Task => ({
  id: action.id,
  agent,
  description,
  action,
  expected: expectedFor(action),
  status: "pending",
  attempts: 0,
  blastRadius: action.blastRadius,
  // Planner approves tasks it admits to the plan; this is its quorum vote.
  approvals: { planner: true, verifier: false, critic: false }
});

const expectedFor = (action: AgentAction): string => {
  switch (action.kind) {
    case "navigate":
      return `navigated to ${action.target ?? ""}`;
    case "fill":
      return `filled ${action.target ?? ""}`;
    case "submit":
      return "submitted";
    case "extract":
      return "extracted content";
    default:
      return "completed";
  }
};
