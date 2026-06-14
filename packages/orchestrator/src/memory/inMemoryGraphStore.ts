import { cosineSimilarity } from "../ports/embedder.js";
import type {
  EdgeFilter,
  EdgeDirection,
  GraphBatch,
  GraphStore,
  NeighborHit,
  NodeFilter,
  VectorHit,
  VectorSearchOptions
} from "./graphStore.js";
import { NATURAL_KEY_PROP } from "./graphStore.js";
import type { EdgeType, KGEdge, KGNode, NodeType, Subgraph } from "./kgTypes.js";

interface Tenant {
  nodes: Map<string, KGNode>;
  edges: Map<string, KGEdge>;
}

/**
 * Reference GraphStore backed by per-install in-memory maps. Enforces tenant
 * isolation structurally: a tenant's nodes/edges are unreachable from another
 * installId. Used as the default store and in all hermetic tests.
 */
export class InMemoryGraphStore implements GraphStore {
  private readonly tenants = new Map<string, Tenant>();

  private tenant(installId: string): Tenant {
    let tenant = this.tenants.get(installId);
    if (!tenant) {
      tenant = { nodes: new Map(), edges: new Map() };
      this.tenants.set(installId, tenant);
    }
    return tenant;
  }

  async upsertNode(node: KGNode): Promise<void> {
    this.tenant(node.installId).nodes.set(node.id, clone(node));
  }

  async upsertEdge(edge: KGEdge): Promise<void> {
    this.tenant(edge.installId).edges.set(edge.id, clone(edge));
  }

  async applyBatch(installId: string, batch: GraphBatch): Promise<void> {
    // JavaScript's single-threaded execution makes this sequence effectively
    // atomic: no other store operation can interleave between these mutations.
    const tenant = this.tenant(installId);
    for (const node of batch.upsertNodes) {
      tenant.nodes.set(node.id, clone(node));
    }
    for (const edge of batch.upsertEdges) {
      tenant.edges.set(edge.id, clone(edge));
    }
    if (batch.deleteNodeIds && batch.deleteNodeIds.length > 0) {
      await this.deleteNodes(installId, batch.deleteNodeIds);
    }
    if (batch.deleteEdgeIds && batch.deleteEdgeIds.length > 0) {
      await this.deleteEdges(installId, batch.deleteEdgeIds);
    }
  }

  async getNode(installId: string, id: string): Promise<KGNode | null> {
    const node = this.tenant(installId).nodes.get(id);
    return node ? clone(node) : null;
  }

  async getNodes(installId: string, ids: string[]): Promise<KGNode[]> {
    const tenant = this.tenant(installId);
    return ids.map((id) => tenant.nodes.get(id)).filter((node): node is KGNode => Boolean(node)).map(clone);
  }

  async listNodes(installId: string, filter: NodeFilter = {}): Promise<KGNode[]> {
    const result: KGNode[] = [];
    for (const node of this.tenant(installId).nodes.values()) {
      if (filter.types && !filter.types.includes(node.type)) continue;
      if (filter.domain !== undefined && node.properties.domain !== filter.domain) continue;
      if (filter.createdAfter !== undefined && node.createdAt < filter.createdAfter) continue;
      if (filter.createdBefore !== undefined && node.createdAt > filter.createdBefore) continue;
      result.push(clone(node));
    }
    return result;
  }

  async listEdges(installId: string, filter: EdgeFilter = {}): Promise<KGEdge[]> {
    const result: KGEdge[] = [];
    for (const edge of this.tenant(installId).edges.values()) {
      if (filter.from !== undefined && edge.from !== filter.from) continue;
      if (filter.to !== undefined && edge.to !== filter.to) continue;
      if (filter.types && !filter.types.includes(edge.type)) continue;
      result.push(clone(edge));
    }
    return result;
  }

  async neighbors(
    installId: string,
    nodeId: string,
    options: { edgeTypes?: EdgeType[] | undefined; direction?: EdgeDirection } = {}
  ): Promise<NeighborHit[]> {
    const tenant = this.tenant(installId);
    const direction = options.direction ?? "both";
    const hits: NeighborHit[] = [];
    for (const edge of tenant.edges.values()) {
      if (options.edgeTypes && !options.edgeTypes.includes(edge.type)) continue;
      let otherId: string | null = null;
      if ((direction === "out" || direction === "both") && edge.from === nodeId) otherId = edge.to;
      else if ((direction === "in" || direction === "both") && edge.to === nodeId) otherId = edge.from;
      if (!otherId) continue;
      const node = tenant.nodes.get(otherId);
      if (node) hits.push({ edge: clone(edge), node: clone(node) });
    }
    return hits;
  }

  async vectorSearch(installId: string, embedding: number[], options: VectorSearchOptions): Promise<VectorHit[]> {
    const minScore = options.minScore ?? -Infinity;
    const hits: VectorHit[] = [];
    for (const node of this.tenant(installId).nodes.values()) {
      if (!node.embedding) continue;
      if (options.types && !options.types.includes(node.type)) continue;
      const score = cosineSimilarity(embedding, node.embedding);
      if (score >= minScore) {
        hits.push({ node: clone(node), score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, options.topK);
  }

  async findByNaturalKey(installId: string, type: NodeType, naturalKey: string): Promise<KGNode | null> {
    for (const node of this.tenant(installId).nodes.values()) {
      if (node.type === type && node.properties[NATURAL_KEY_PROP] === naturalKey) {
        return clone(node);
      }
    }
    return null;
  }

  async deleteNodes(installId: string, ids: string[]): Promise<number> {
    const tenant = this.tenant(installId);
    const idSet = new Set(ids);
    let removed = 0;
    for (const id of ids) {
      if (tenant.nodes.delete(id)) removed += 1;
    }
    // Cascade: drop edges incident to any deleted node.
    for (const [edgeId, edge] of tenant.edges) {
      if (idSet.has(edge.from) || idSet.has(edge.to)) {
        tenant.edges.delete(edgeId);
      }
    }
    return removed;
  }

  async deleteEdges(installId: string, ids: string[]): Promise<number> {
    const tenant = this.tenant(installId);
    let removed = 0;
    for (const id of ids) {
      if (tenant.edges.delete(id)) removed += 1;
    }
    return removed;
  }

  async touch(installId: string, ids: string[], nowMs: number): Promise<void> {
    const tenant = this.tenant(installId);
    for (const id of ids) {
      const node = tenant.nodes.get(id);
      if (node) {
        node.accessCount += 1;
        node.lastAccessedAt = nowMs;
      }
    }
  }

  async exportAll(installId: string): Promise<Subgraph> {
    const tenant = this.tenant(installId);
    return {
      nodes: [...tenant.nodes.values()].map(clone),
      edges: [...tenant.edges.values()].map(clone)
    };
  }
}

const clone = <T>(value: T): T => structuredClone(value);
