import crypto from "node:crypto";
import type { AgentName } from "../types.js";
import type { Embedder } from "../ports/embedder.js";
import { ConsolidationEngine } from "./consolidation.js";
import type { ConsolidationOptions, ConsolidationReport } from "./consolidation.js";
import type { FieldCipher } from "./crypto.js";
import type { GraphStore } from "./graphStore.js";
import type { KGNode, MemoryEvent, Subgraph } from "./kgTypes.js";
import { HybridRetriever } from "./retriever.js";
import type { RetrievalProfileName, RetrieveOptions, RetrievedSubgraph } from "./retriever.js";
import type { EntityExtractor, WriteResult } from "./writer.js";
import { MemoryWriter } from "./writer.js";

export type MemoryAuditEvent =
  | {
      type: "retrieval";
      agent: AgentName;
      installId: string;
      profile: RetrievalProfileName;
      queryHash: string;
      returnedNodeIds: string[];
      ts: number;
    }
  | { type: "export"; installId: string; nodeCount: number; unsealed: boolean; ts: number }
  | { type: "forget"; installId: string; scope: string; removed: number; ts: number }
  | { type: "pause"; installId: string; paused: boolean; ts: number }
  | { type: "write"; installId: string; nodesWritten: number; edgesWritten: number; ts: number };

export type ForgetScope =
  | { kind: "node"; nodeId: string }
  | { kind: "edge"; edgeId: string }
  | { kind: "domain"; domain: string }
  | { kind: "timeRange"; from: number; to: number };

export interface ForgetResult {
  removed: number;
}

export interface ExportedNode extends KGNode {
  /** Decrypted sealed fields, present only when export requested unsealing. */
  revealed?: Record<string, string>;
}

export interface ExportBundle {
  installId: string;
  exportedAt: number;
  nodes: ExportedNode[];
  edges: Subgraph["edges"];
}

export interface MemorySystemDeps {
  store: GraphStore;
  embedder: Embedder;
  cipher: FieldCipher;
  clock?: () => number;
  newId?: () => string;
  audit?: (event: MemoryAuditEvent) => void;
  entityExtractor?: EntityExtractor;
}

/**
 * First-class memory subsystem owned by the Memory agent. Composes the write
 * path, hybrid retriever and consolidation jobs, and owns the privacy surface
 * (export, cascading forget, pause-recording) — all per-install scoped.
 */
export class MemorySystem {
  readonly writer: MemoryWriter;
  readonly retriever: HybridRetriever;
  readonly consolidation: ConsolidationEngine;

  private readonly store: GraphStore;
  private readonly cipher: FieldCipher;
  private readonly clock: () => number;
  private readonly audit?: (event: MemoryAuditEvent) => void;
  private readonly paused = new Set<string>();

  constructor(deps: MemorySystemDeps) {
    this.store = deps.store;
    this.cipher = deps.cipher;
    this.clock = deps.clock ?? (() => Date.now());
    this.audit = deps.audit;
    this.writer = new MemoryWriter({
      store: deps.store,
      embedder: deps.embedder,
      cipher: deps.cipher,
      clock: this.clock,
      newId: deps.newId,
      entityExtractor: deps.entityExtractor
    });
    this.retriever = new HybridRetriever({
      store: deps.store,
      embedder: deps.embedder,
      clock: this.clock,
      audit: (entry) => this.audit?.({ type: "retrieval", ...entry })
    });
    this.consolidation = new ConsolidationEngine({
      store: deps.store,
      embedder: deps.embedder,
      clock: this.clock,
      newId: deps.newId
    });
  }

  /** Write path. Dropped silently when recording is paused for the install. */
  async recordEvents(events: MemoryEvent[]): Promise<WriteResult[]> {
    const allowed = events.filter((event) => !this.paused.has(event.installId));
    if (allowed.length === 0) return [];
    const results = await this.writer.write(allowed);
    for (const result of results) {
      this.audit?.({
        type: "write",
        installId: result.installId,
        nodesWritten: result.nodesWritten,
        edgesWritten: result.edgesWritten,
        ts: this.clock()
      });
    }
    return results;
  }

  retrieve(options: RetrieveOptions): Promise<RetrievedSubgraph> {
    return this.retriever.retrieve(options);
  }

  consolidate(installId: string, options?: ConsolidationOptions): Promise<ConsolidationReport> {
    return this.consolidation.run(installId, options);
  }

  setPaused(installId: string, paused: boolean): void {
    if (paused) this.paused.add(installId);
    else this.paused.delete(installId);
    this.audit?.({ type: "pause", installId, paused, ts: this.clock() });
  }

  isPaused(installId: string): boolean {
    return this.paused.has(installId);
  }

  /** Full export. When unseal=true, sensitive fields are decrypted for the user. */
  async export(installId: string, options: { unseal?: boolean } = {}): Promise<ExportBundle> {
    const subgraph = await this.store.exportAll(installId);
    const unseal = options.unseal ?? false;
    const nodes: ExportedNode[] = subgraph.nodes.map((node) => {
      if (!unseal || !node.sealed) return node;
      const revealed: Record<string, string> = {};
      for (const [field, sealedField] of Object.entries(node.sealed)) {
        revealed[field] = this.cipher.open(installId, sealedField);
      }
      return { ...node, revealed };
    });
    this.audit?.({ type: "export", installId, nodeCount: nodes.length, unsealed: unseal, ts: this.clock() });
    return { installId, exportedAt: this.clock(), nodes, edges: subgraph.edges };
  }

  /** Cascading forget by node / edge / domain / time-range. */
  async forget(installId: string, scope: ForgetScope): Promise<ForgetResult> {
    let removed = 0;
    switch (scope.kind) {
      case "node":
        removed = await this.store.deleteNodes(installId, [scope.nodeId]);
        break;
      case "edge":
        removed = await this.store.deleteEdges(installId, [scope.edgeId]);
        break;
      case "domain": {
        const domainNodes = await this.store.listNodes(installId, { domain: scope.domain });
        const domainEntity = await this.store.findByNaturalKey(installId, "Domain", `domain:${scope.domain}`);
        const ids = new Set(domainNodes.map((node) => node.id));
        if (domainEntity) ids.add(domainEntity.id);
        removed = await this.store.deleteNodes(installId, [...ids]);
        break;
      }
      case "timeRange": {
        const inRange = await this.store.listNodes(installId, {
          createdAfter: scope.from,
          createdBefore: scope.to
        });
        removed = await this.store.deleteNodes(installId, inRange.map((node) => node.id));
        break;
      }
      default:
        removed = 0;
    }
    this.audit?.({ type: "forget", installId, scope: scope.kind, removed, ts: this.clock() });
    return { removed };
  }
}

/** Convenience: default in-memory MemorySystem with a deterministic id factory. */
export const createDefaultMemorySystem = (deps: {
  store: GraphStore;
  embedder: Embedder;
  cipher: FieldCipher;
  audit?: (event: MemoryAuditEvent) => void;
}): MemorySystem =>
  new MemorySystem({
    store: deps.store,
    embedder: deps.embedder,
    cipher: deps.cipher,
    audit: deps.audit,
    newId: () => crypto.randomUUID()
  });
