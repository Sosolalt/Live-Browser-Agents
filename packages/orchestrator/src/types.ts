// Shared domain types for the autonomous orchestrator (Phase 7) and the
// User Knowledge Graph (Phase 8). These are transport-agnostic: the backend
// runs the graph and dispatches AgentActions, the extension executes them on
// the real DOM and returns ActionResults. No LangChain/LangGraph types leak here.

export type AgentName =
  | "planner"
  | "perception"
  | "researcher"
  | "navigator"
  | "form"
  | "extractor"
  | "verifier"
  | "critic"
  | "memory";

/** Worker agents that own task execution (a subset of AgentName). */
export type WorkerAgent = "navigator" | "form" | "extractor";

/** How destructive/irreversible an action is. Drives the quorum gate. */
export type BlastRadius = "low" | "medium" | "high";

export type ActionKind =
  | "navigate"
  | "click"
  | "fill"
  | "submit"
  | "extract"
  | "scroll"
  | "wait"
  | "noop";

export interface AgentAction {
  id: string;
  kind: ActionKind;
  /** CSS selector or URL depending on kind. */
  target?: string;
  /** Value for fill/navigate. Sensitive values are redacted before memory write. */
  value?: string;
  rationale?: string;
  blastRadius: BlastRadius;
}

export interface ActionResult {
  actionId: string;
  ok: boolean;
  observation: string;
  /** Post-action page state used by the Verifier to confirm the effect. */
  postState?: Record<string, unknown>;
  error?: string;
  /** True when the executor can deterministically undo this action. */
  reversible: boolean;
  /** Inverse action the Verifier can dispatch to roll back on divergence. */
  undo?: AgentAction | null;
}

export interface InteractiveElement {
  selector: string;
  role: string;
  label: string;
  confidence: number;
}

export interface DomSnapshot {
  url: string;
  title: string;
  elements: InteractiveElement[];
  /** Redacted, goal-relevant text content. */
  text: string;
}

export interface ResearchResult {
  summary: string;
  citations: string[];
  /** Node ids from the knowledge-graph subgraph used to ground the answer. */
  groundingNodeIds: string[];
}

export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface QuorumApprovals {
  planner: boolean;
  verifier: boolean;
  critic: boolean;
}

export interface Task {
  id: string;
  agent: WorkerAgent;
  description: string;
  action: AgentAction;
  /** Natural-language post-condition the Verifier checks against postState. */
  expected: string;
  status: TaskStatus;
  attempts: number;
  blastRadius: BlastRadius;
  approvals: QuorumApprovals;
}

export interface Plan {
  tasks: Task[];
  cursor: number;
}

export interface VerifierResult {
  taskId: string;
  passed: boolean;
  reason: string;
  /** Verifier requests a rollback of the last action when post-state diverged. */
  rollback: boolean;
  anomaly: boolean;
}

export interface CriticDecision {
  taskId: string;
  approved: boolean;
  blastRadius: BlastRadius;
  /** Structured rejection reasons when approved=false. */
  reasons: string[];
  /** Quorum required because the action is high blast-radius. */
  quorumRequired: boolean;
}

export interface SessionBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxCostMicros: number;
}

export interface BudgetUsage {
  steps: number;
  toolCalls: number;
  costMicros: number;
}

export type RunStatus = "running" | "done" | "terminated" | "error";

export type TerminationReason =
  | "completed"
  | "budget_steps"
  | "budget_tool_calls"
  | "budget_cost"
  | "anomaly"
  | "critic_veto"
  | "quorum_failed"
  | "no_plan"
  | "error";
