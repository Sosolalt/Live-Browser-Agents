import type { EdgeType, KGEdge, KGNode, NodeType, Subgraph } from "./kgTypes.js";

export type EdgeDirection = "out" | "in" | "both";

export interface NodeFilter {
  types?: NodeType[];
  /** Matches nodes whose `properties.domain` equals this value. */
  domain?: string;
  createdAfter?: number;
  createdBefore?: number;
}

export interface EdgeFilter {
  from?: string;
  to?: string;
  types?: EdgeType[];
}

export interface VectorSearchOptions {
  topK: number;
  types?: NodeType[];
  minScore?: number;
}

export interface VectorHit {
  node: KGNode;
  score: number;
}

export interface NeighborHit {
  edge: KGEdge;
  node: KGNode;
}

/** Atomic unit of work for the write path ("nodes + edges in one transaction"). */
export interface GraphBatch {
  upsertNodes: KGNode[];
  upsertEdges: KGEdge[];
  deleteNodeIds?: string[];
  deleteEdgeIds?: string[];
}

/**
 * Persistence port for the User Knowledge Graph. Every method is scoped by
 * `installId` — there is no cross-tenant traversal at the query layer. The
 * in-memory and Postgres(+pgvector) implementations are interchangeable.
 */
export interface GraphStore {
  upsertNode(node: KGNode): Promise<void>;
  upsertEdge(edge: KGEdge): Promise<void>;
  /** Applies all upserts/deletes atomically (single transaction in Postgres). */
  applyBatch(installId: string, batch: GraphBatch): Promise<void>;
  getNode(installId: string, id: string): Promise<KGNode | null>;
  getNodes(installId: string, ids: string[]): Promise<KGNode[]>;
  listNodes(installId: string, filter?: NodeFilter): Promise<KGNode[]>;
  listEdges(installId: string, filter?: EdgeFilter): Promise<KGEdge[]>;
  neighbors(
    installId: string,
    nodeId: string,
    options?: { edgeTypes?: EdgeType[]; direction?: EdgeDirection }
  ): Promise<NeighborHit[]>;
  vectorSearch(installId: string, embedding: number[], options: VectorSearchOptions): Promise<VectorHit[]>;
  findByNaturalKey(installId: string, type: NodeType, naturalKey: string): Promise<KGNode | null>;
  /** Deletes nodes and cascades to all incident edges. Returns nodes removed. */
  deleteNodes(installId: string, ids: string[]): Promise<number>;
  deleteEdges(installId: string, ids: string[]): Promise<number>;
  /** Records an access for decay scoring (accessCount++, lastAccessedAt). */
  touch(installId: string, ids: string[], nowMs: number): Promise<void>;
  exportAll(installId: string): Promise<Subgraph>;
}

/** Natural-key marker stored in `properties` so dedupe is store-agnostic. */
export const NATURAL_KEY_PROP = "_naturalKey";

export const naturalKeyOf = (node: Pick<KGNode, "properties">): string | undefined => {
  const value = node.properties[NATURAL_KEY_PROP];
  return typeof value === "string" ? value : undefined;
};
