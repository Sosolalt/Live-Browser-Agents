import type { AgentName } from "../types.js";
import type { SealedField } from "./crypto.js";

// Typed, per-install ("installId"-scoped) knowledge graph. Obsidian-style: every
// node is a first-class object with typed, weighted, timestamped edges.

export type NodeType =
  | "Session"
  | "Intent"
  | "Task"
  | "Subtask"
  | "Action"
  | "PageVisit"
  | "Domain"
  | "Entity"
  | "Observation"
  | "Decision"
  | "Preference"
  | "Skill"
  | "Concept"
  | "TimeAnchor"
  | "Failure";

/** Entity sub-types carried in `properties.entityType`. */
export type EntityType =
  | "Person"
  | "Product"
  | "Order"
  | "Address"
  | "Account"
  | "Document"
  | "Other";

export type EdgeType =
  | "PRECEDED_BY"
  | "CAUSED"
  | "REFERS_TO"
  | "BELONGS_TO"
  | "DERIVED_FROM"
  | "CONTRADICTS"
  | "REINFORCES"
  | "SIMILAR_TO"
  | "ABSTRACTS"
  | "TRIGGERED_BY"
  | "SUPERSEDES";

export type MemoryTier = "hot" | "cold";

export interface KGNode {
  id: string;
  installId: string;
  type: NodeType;
  label: string;
  /** Non-sensitive typed payload (JSONB in Postgres). */
  properties: Record<string, unknown>;
  /** Field-level AEAD-sealed sensitive payload, keyed by field name. */
  sealed: Record<string, SealedField> | null;
  embedding: number[] | null;
  importance: number;
  confidence: number;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  /** Per-node retention; null = governed by node-type default. */
  ttlMs: number | null;
  tier: MemoryTier;
  provenance: string;
}

export interface KGEdge {
  id: string;
  installId: string;
  type: EdgeType;
  from: string;
  to: string;
  weight: number;
  properties: Record<string, unknown>;
  createdAt: number;
}

export interface Subgraph {
  nodes: KGNode[];
  edges: KGEdge[];
}

export type MemoryEventKind =
  | "session_started"
  | "intent_captured"
  | "task_planned"
  | "action_taken"
  | "page_visited"
  | "observation"
  | "decision"
  | "preference"
  | "failure"
  | "skill_candidate";

/**
 * Agents never write the graph directly. They emit MemoryEvents (via callbacks);
 * the Memory agent normalizes, dedupes, embeds, PII-gates and writes them.
 */
export interface MemoryEvent {
  kind: MemoryEventKind;
  installId: string;
  sessionId: string;
  ts: number;
  source: AgentName;
  payload: Record<string, unknown>;
  refs?: {
    causedBy?: string;
    refersTo?: string;
    belongsTo?: string;
  };
}

/** Default importance seeds per node type (0..1); tuned by decay later. */
export const DEFAULT_IMPORTANCE: Record<NodeType, number> = {
  Session: 0.4,
  Intent: 0.7,
  Task: 0.55,
  Subtask: 0.45,
  Action: 0.35,
  PageVisit: 0.25,
  Domain: 0.5,
  Entity: 0.6,
  Observation: 0.4,
  Decision: 0.65,
  Preference: 0.85,
  Skill: 0.9,
  Concept: 0.75,
  TimeAnchor: 0.3,
  Failure: 0.7
};

/** Retention TTL per node type (ms). PageVisit short, Preference/Skill long. */
const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_TTL_MS: Record<NodeType, number> = {
  Session: 30 * DAY,
  Intent: 90 * DAY,
  Task: 30 * DAY,
  Subtask: 30 * DAY,
  Action: 14 * DAY,
  PageVisit: 7 * DAY,
  Domain: 365 * DAY,
  Entity: 365 * DAY,
  Observation: 30 * DAY,
  Decision: 180 * DAY,
  Preference: 730 * DAY,
  Skill: 730 * DAY,
  Concept: 365 * DAY,
  TimeAnchor: 365 * DAY,
  Failure: 180 * DAY
};

export const ttlForNode = (node: Pick<KGNode, "type" | "ttlMs">): number => node.ttlMs ?? DEFAULT_TTL_MS[node.type];
