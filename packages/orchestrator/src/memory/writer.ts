import crypto from "node:crypto";
import type { Embedder } from "../ports/embedder.js";
import type { FieldCipher } from "./crypto.js";
import type { GraphBatch, GraphStore } from "./graphStore.js";
import { NATURAL_KEY_PROP } from "./graphStore.js";
import { DEFAULT_IMPORTANCE } from "./kgTypes.js";
import type { EdgeType, EntityType, KGEdge, KGNode, MemoryEvent, NodeType } from "./kgTypes.js";
import { PiiGate } from "./pii.js";

export type EntityExtractor = (text: string) => Promise<Array<{ name: string; type: EntityType }>>;

export interface MemoryWriterDeps {
  store: GraphStore;
  embedder: Embedder;
  cipher: FieldCipher;
  pii?: PiiGate;
  clock?: () => number;
  newId?: () => string;
  entityExtractor?: EntityExtractor;
  /** Cosine threshold above which two entities are treated as the same node. */
  mergeThreshold?: number;
  /** Cosine threshold above which a SIMILAR_TO edge is added (Obsidian-style). */
  linkThreshold?: number;
}

export interface WriteResult {
  installId: string;
  nodesWritten: number;
  edgesWritten: number;
  mergedEntities: number;
  supersededNodes: number;
}

interface BuiltNode {
  node: KGNode;
  /** When true the node already existed and was reinforced in place. */
  reused: boolean;
}

/**
 * The Memory agent's write path. Agents emit MemoryEvents; this normalizes them
 * into typed nodes + edges, dedupes by natural key, extracts/embeds entities,
 * resolves coreference, runs the PII gate (sealing sensitive fields), and writes
 * everything for an install in a single atomic batch.
 */
export class MemoryWriter {
  private readonly store: GraphStore;
  private readonly embedder: Embedder;
  private readonly cipher: FieldCipher;
  private readonly pii: PiiGate;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private readonly extractEntities: EntityExtractor;
  private readonly mergeThreshold: number;
  private readonly linkThreshold: number;

  constructor(deps: MemoryWriterDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.cipher = deps.cipher;
    this.pii = deps.pii ?? new PiiGate();
    this.clock = deps.clock ?? (() => Date.now());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.extractEntities = deps.entityExtractor ?? heuristicEntityExtractor;
    this.mergeThreshold = deps.mergeThreshold ?? 0.95;
    this.linkThreshold = deps.linkThreshold ?? 0.8;
  }

  async write(events: MemoryEvent[]): Promise<WriteResult[]> {
    const byInstall = new Map<string, MemoryEvent[]>();
    for (const event of events) {
      const bucket = byInstall.get(event.installId) ?? [];
      bucket.push(event);
      byInstall.set(event.installId, bucket);
    }
    const results: WriteResult[] = [];
    for (const [installId, bucket] of byInstall) {
      results.push(await this.writeForInstall(installId, bucket));
    }
    return results;
  }

  private async writeForInstall(installId: string, events: MemoryEvent[]): Promise<WriteResult> {
    const nodes = new Map<string, KGNode>();
    const edges = new Map<string, KGEdge>();
    // In-batch dedupe indexes so nodes created earlier in this batch are reused.
    const byNaturalKey = new Map<string, KGNode>();
    const lastByType = new Map<NodeType, string>();
    let mergedEntities = 0;
    let supersededNodes = 0;

    const stage = (node: KGNode): void => {
      nodes.set(node.id, node);
      const key = naturalKeyOf(node);
      if (key) byNaturalKey.set(key, node);
    };
    const link = (type: EdgeType, from: string, to: string, weight = 1): void => {
      if (from === to) return;
      const id = this.newId();
      edges.set(id, {
        id,
        installId,
        type,
        from,
        to,
        weight,
        properties: {},
        createdAt: this.clock()
      });
    };

    const resolveByKey = async (
      type: NodeType,
      naturalKey: string,
      build: () => Omit<KGNode, "id">
    ): Promise<BuiltNode> => {
      const existing = byNaturalKey.get(naturalKey) ?? (await this.store.findByNaturalKey(installId, type, naturalKey));
      if (existing) {
        const reinforced = nodes.get(existing.id) ?? { ...existing };
        reinforced.importance = clamp01(reinforced.importance + 0.05);
        reinforced.confidence = Math.max(reinforced.confidence, build().confidence);
        reinforced.updatedAt = this.clock();
        stage(reinforced);
        return { node: reinforced, reused: true };
      }
      const node: KGNode = { ...build(), id: this.newId() };
      stage(node);
      return { node, reused: false };
    };

    for (const event of events) {
      const primary = await this.buildPrimary(installId, event);
      if (!primary) continue;

      // Stamp the natural key into properties so the store can dedupe/look it up.
      if (primary.naturalKey) {
        primary.node = {
          ...primary.node,
          properties: { ...primary.node.properties, [NATURAL_KEY_PROP]: primary.naturalKey }
        };
      }

      let primaryNode: KGNode;
      if (primary.naturalKey && primary.dedupe !== false) {
        const resolved = await resolveByKey(primary.type, primary.naturalKey, () => primary.node);
        primaryNode = resolved.node;
      } else {
        primaryNode = { ...primary.node, id: this.newId() };
        stage(primaryNode);
      }

      // Chain same-type events chronologically.
      const previousId = lastByType.get(primary.type);
      if (previousId && previousId !== primaryNode.id) {
        link("PRECEDED_BY", primaryNode.id, previousId);
      }
      lastByType.set(primary.type, primaryNode.id);

      // Reference edges from the event.
      if (event.refs?.belongsTo) link("BELONGS_TO", primaryNode.id, event.refs.belongsTo);
      if (event.refs?.refersTo) link("REFERS_TO", primaryNode.id, event.refs.refersTo);
      if (event.refs?.causedBy) link("CAUSED", event.refs.causedBy, primaryNode.id);

      // Anchor every node to its Session (when one exists) so the session is the
      // episodic hub: powers episode compaction and per-session retrieval.
      if (primary.type !== "Session") {
        const sessionKey = `session:${event.sessionId}`;
        const sessionNode =
          byNaturalKey.get(sessionKey) ?? (await this.store.findByNaturalKey(installId, "Session", sessionKey));
        if (sessionNode) link("BELONGS_TO", primaryNode.id, sessionNode.id);
      }

      // Preference contradiction → SUPERSEDES (history retained).
      if (primary.supersedeKey) {
        const prior = await this.store.findByNaturalKey(installId, "Preference", primary.supersedeKey);
        if (prior && prior.label !== primaryNode.label && prior.id !== primaryNode.id) {
          const superseded = { ...prior, properties: { ...prior.properties, superseded: true }, updatedAt: this.clock() };
          stage(superseded);
          link("SUPERSEDES", primaryNode.id, superseded.id);
          supersededNodes += 1;
        }
      }

      // Domain rollup for page visits.
      if (primary.domain) {
        const domain = await resolveByKey("Domain", `domain:${primary.domain}`, () =>
          this.makeNode(installId, "Domain", primary.domain as string, { domain: primary.domain }, event)
        );
        link("BELONGS_TO", primaryNode.id, domain.node.id);
      }

      // Entity extraction + coreference.
      if (primary.entityText) {
        const found = await this.extractEntities(primary.entityText);
        for (const entity of found) {
          const resolved = await this.resolveEntity(installId, entity, event, nodes, byNaturalKey);
          if (resolved.merged) mergedEntities += 1;
          link("REFERS_TO", primaryNode.id, resolved.node.id);
          for (const similar of resolved.similarTo) {
            link("SIMILAR_TO", resolved.node.id, similar, 0.85);
          }
        }
      }
    }

    const batch: GraphBatch = { upsertNodes: [...nodes.values()], upsertEdges: [...edges.values()] };
    await this.store.applyBatch(installId, batch);
    return {
      installId,
      nodesWritten: batch.upsertNodes.length,
      edgesWritten: batch.upsertEdges.length,
      mergedEntities,
      supersededNodes
    };
  }

  private async resolveEntity(
    installId: string,
    entity: { name: string; type: EntityType },
    event: MemoryEvent,
    nodes: Map<string, KGNode>,
    byNaturalKey: Map<string, KGNode>
  ): Promise<{ node: KGNode; merged: boolean; similarTo: string[] }> {
    // Hash the name into the key so sensitive entity names (emails, etc.) never
    // appear in plaintext in `_naturalKey` while dedupe stays deterministic.
    const naturalKey = `entity:${entity.type}:${hash(normalize(entity.name))}`;
    const inBatch = byNaturalKey.get(naturalKey);
    if (inBatch) return { node: inBatch, merged: true, similarTo: [] };

    const exact = await this.store.findByNaturalKey(installId, "Entity", naturalKey);
    if (exact) {
      const reinforced = { ...exact, importance: clamp01(exact.importance + 0.05), updatedAt: this.clock() };
      nodes.set(reinforced.id, reinforced);
      byNaturalKey.set(naturalKey, reinforced);
      return { node: reinforced, merged: true, similarTo: [] };
    }

    const node = await this.makeNodeAsync(
      installId,
      "Entity",
      entity.name,
      { entityType: entity.type, name: entity.name, [NATURAL_KEY_PROP]: naturalKey },
      event
    );

    // Coreference across domains via embedding similarity.
    const similarTo: string[] = [];
    let merged = false;
    if (node.embedding) {
      const hits = await this.store.vectorSearch(installId, node.embedding, { topK: 3, types: ["Entity"] });
      for (const hit of hits) {
        if (hit.node.properties.entityType !== entity.type) continue;
        if (hit.score >= this.mergeThreshold) {
          const reinforced = { ...hit.node, importance: clamp01(hit.node.importance + 0.05), updatedAt: this.clock() };
          nodes.set(reinforced.id, reinforced);
          byNaturalKey.set(naturalKey, reinforced);
          return { node: reinforced, merged: true, similarTo: [] };
        }
        if (hit.score >= this.linkThreshold) {
          similarTo.push(hit.node.id);
          merged = false;
        }
      }
    }

    nodes.set(node.id, node);
    byNaturalKey.set(naturalKey, node);
    return { node, merged, similarTo };
  }

  private async buildPrimary(
    installId: string,
    event: MemoryEvent
  ): Promise<{
    type: NodeType;
    node: KGNode;
    naturalKey?: string;
    /** When false, never reuse an existing node with this key (e.g. Preference). */
    dedupe?: boolean;
    supersedeKey?: string;
    domain?: string;
    entityText?: string;
  } | null> {
    const p = event.payload;
    switch (event.kind) {
      case "session_started":
        return {
          type: "Session",
          naturalKey: `session:${event.sessionId}`,
          node: this.makeNode(installId, "Session", `session ${event.sessionId}`, { sessionId: event.sessionId }, event)
        };
      case "intent_captured": {
        const text = str(p.text);
        return {
          type: "Intent",
          naturalKey: `intent:${event.sessionId}:${hash(text)}`,
          entityText: text,
          node: await this.makeNodeAsync(installId, "Intent", text, { text }, event)
        };
      }
      case "task_planned": {
        const description = str(p.description);
        return {
          type: "Task",
          naturalKey: p.taskId ? `task:${str(p.taskId)}` : undefined,
          node: await this.makeNodeAsync(installId, "Task", description, { ...p }, event)
        };
      }
      case "action_taken":
        return {
          type: "Action",
          node: await this.makeNodeAsync(installId, "Action", str(p.summary) || str(p.kind), { ...p }, event)
        };
      case "page_visited": {
        const url = str(p.url);
        return {
          type: "PageVisit",
          domain: str(p.domain) || domainOf(url),
          entityText: `${str(p.title)} ${str(p.text)}`.trim(),
          node: this.makeNode(installId, "PageVisit", url, { url, title: p.title, domain: str(p.domain) || domainOf(url) }, event)
        };
      }
      case "observation": {
        const text = str(p.text);
        return {
          type: "Observation",
          entityText: text,
          node: await this.makeNodeAsync(installId, "Observation", text, { text }, event)
        };
      }
      case "decision":
        return {
          type: "Decision",
          node: this.makeNode(installId, "Decision", str(p.text) || "decision", { ...p }, event)
        };
      case "preference": {
        const key = str(p.key);
        return {
          type: "Preference",
          // Stored (for supersede lookup) but not deduped: a changed value must
          // create a new node so the old one can be superseded and retained.
          naturalKey: `pref:${key}`,
          dedupe: false,
          supersedeKey: `pref:${key}`,
          node: await this.makeNodeAsync(installId, "Preference", str(p.value) || key, { key, value: p.value }, event)
        };
      }
      case "failure":
        return {
          type: "Failure",
          node: this.makeNode(installId, "Failure", str(p.reason) || "failure", { ...p }, event)
        };
      case "skill_candidate":
        // Skills are promoted by the consolidation job from repeated success, not
        // written directly. The event is recorded as an Observation marker.
        return {
          type: "Observation",
          node: this.makeNode(installId, "Observation", `skill candidate: ${str(p.skill)}`, { skillCandidate: true, ...p }, event)
        };
      default:
        return null;
    }
  }

  /** Builds a node, running the PII gate + sealing, without an embedding. */
  private makeNode(
    installId: string,
    type: NodeType,
    label: string,
    properties: Record<string, unknown>,
    event: MemoryEvent
  ): KGNode {
    const scan = this.pii.scan(properties);
    const sealed = this.seal(installId, scan.sealable);
    const now = this.clock();
    return {
      id: this.newId(),
      installId,
      type,
      label: scrubLabel(label, scan.sensitiveValues),
      properties: scan.safeProperties,
      sealed,
      embedding: null,
      importance: DEFAULT_IMPORTANCE[type],
      confidence: num(event.payload.confidence, 0.7),
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      ttlMs: null,
      tier: "hot",
      provenance: `agent:${event.source}`
    };
  }

  /** Like makeNode but computes an embedding from the label + safe text. */
  private async makeNodeAsync(
    installId: string,
    type: NodeType,
    label: string,
    properties: Record<string, unknown>,
    event: MemoryEvent
  ): Promise<KGNode> {
    const node = this.makeNode(installId, type, label, properties, event);
    node.embedding = await this.embedder.embed(`${type} ${node.label}`);
    return node;
  }

  private seal(installId: string, sealable: Record<string, string>): KGNode["sealed"] {
    const entries = Object.entries(sealable);
    if (entries.length === 0) return null;
    const sealed: NonNullable<KGNode["sealed"]> = {};
    for (const [field, plaintext] of entries) {
      sealed[field] = this.cipher.seal(installId, plaintext);
    }
    return sealed;
  }
}

const naturalKeyOf = (node: KGNode): string | undefined => {
  const value = node.properties[NATURAL_KEY_PROP];
  return typeof value === "string" ? value : undefined;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const str = (value: unknown): string => (typeof value === "string" ? value : value === undefined ? "" : String(value));
const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);
const normalize = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** Don't leak sealed/hashed/redacted plaintext into the (unsealed) label. */
const scrubLabel = (label: string, sensitiveValues: string[]): string => {
  let result = label;
  for (const plaintext of sensitiveValues) {
    if (plaintext && result.includes(plaintext)) {
      result = result.split(plaintext).join("[redacted]");
    }
  }
  return result;
};

export const heuristicEntityExtractor: EntityExtractor = async (text: string) => {
  const entities: Array<{ name: string; type: EntityType }> = [];
  const order = /\border\s*#?\s*([a-z0-9-]{4,})/i.exec(text);
  if (order) entities.push({ name: order[1], type: "Order" });
  const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(text);
  if (email) entities.push({ name: email[0], type: "Account" });
  const product = /\b(?:buy|order|purchase|cart)\s+([A-Z][\w-]{2,})/.exec(text);
  if (product) entities.push({ name: product[1], type: "Product" });
  return entities;
};
