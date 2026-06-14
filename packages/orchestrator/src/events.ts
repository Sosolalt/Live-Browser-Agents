import type { AgentName } from "./types.js";

// Node-level event stream for observability only. The popup may *watch* these
// events; it can never approve or block (autonomy is enforced in-graph).

export type OrchestratorEventType =
  | "run_started"
  | "node_started"
  | "node_finished"
  | "plan_created"
  | "action_dispatched"
  | "action_result"
  | "verifier_result"
  | "critic_decision"
  | "quorum_decision"
  | "memory_write"
  | "anomaly_detected"
  | "budget_exhausted"
  | "run_finished"
  | "error";

export interface OrchestratorEvent {
  type: OrchestratorEventType;
  runId: string;
  installId: string;
  sessionId: string;
  ts: number;
  node?: AgentName;
  data?: Record<string, unknown>;
}

export type EventSink = (event: OrchestratorEvent) => void;

type Subscriber = (event: OrchestratorEvent) => void;

/**
 * In-process pub/sub for orchestrator events with bounded per-run history so
 * a late SSE subscriber can replay what already happened. A durable transport
 * (Redis stream, etc.) can implement the same publish/subscribe shape later.
 */
export class EventBus {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private readonly history = new Map<string, OrchestratorEvent[]>();
  private readonly finished = new Set<string>();
  private readonly maxHistoryPerRun: number;

  constructor(options: { maxHistoryPerRun?: number } = {}) {
    this.maxHistoryPerRun = options.maxHistoryPerRun ?? 1000;
  }

  publish(event: OrchestratorEvent): void {
    const log = this.history.get(event.runId) ?? [];
    log.push(event);
    if (log.length > this.maxHistoryPerRun) {
      log.splice(0, log.length - this.maxHistoryPerRun);
    }
    this.history.set(event.runId, log);
    if (event.type === "run_finished" || event.type === "error") {
      this.finished.add(event.runId);
    }
    const subs = this.subscribers.get(event.runId);
    if (subs) {
      for (const sub of subs) {
        sub(event);
      }
    }
  }

  /** Returns an unsubscribe function. Existing history is NOT auto-replayed. */
  subscribe(runId: string, subscriber: Subscriber): () => void {
    const subs = this.subscribers.get(runId) ?? new Set<Subscriber>();
    subs.add(subscriber);
    this.subscribers.set(runId, subs);
    return () => {
      const current = this.subscribers.get(runId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) {
        this.subscribers.delete(runId);
      }
    };
  }

  getHistory(runId: string): OrchestratorEvent[] {
    return [...(this.history.get(runId) ?? [])];
  }

  isFinished(runId: string): boolean {
    return this.finished.has(runId);
  }
}
