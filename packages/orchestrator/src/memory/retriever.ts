import type { AgentName } from "../types.js";
import type { Embedder } from "../ports/embedder.js";
import type { GraphStore } from "./graphStore.js";
import type { EdgeType, KGEdge, KGNode, NodeType, Subgraph } from "./kgTypes.js";

// Hybrid graph retrieval: the LangChain Retriever returns a typed *subgraph*
// (not flat docs). Pipeline: vector top-k seed -> k-hop typed-edge expansion ->
// importance x recency x path-weight re-rank -> token-budgeted truncation.

export type RetrievalProfileName = "planner" | "form" | "researcher" | "verifier" | "critic" | "memory";

export interface RetrievalProfile {
  /** Node types used to seed the vector search. */
  seedTypes: NodeType[];
  /** Edge types followed during k-hop expansion. */
  expandEdges: EdgeType[];
  hops: number;
}

/** Per-agent retrieval profiles (README "Read path"). */
export const RETRIEVAL_PROFILES: Record<RetrievalProfileName, RetrievalProfile> = {
  planner: {
    seedTypes: ["Skill", "Task", "Intent", "Action"],
    expandEdges: ["PRECEDED_BY", "CAUSED", "BELONGS_TO", "ABSTRACTS"],
    hops: 2
  },
  form: {
    seedTypes: ["Preference", "Entity"],
    expandEdges: ["REFERS_TO", "REINFORCES", "SUPERSEDES"],
    hops: 1
  },
  researcher: {
    seedTypes: ["Domain", "Concept", "Entity"],
    expandEdges: ["ABSTRACTS", "REFERS_TO", "BELONGS_TO", "SIMILAR_TO"],
    hops: 2
  },
  verifier: {
    seedTypes: ["Failure", "PageVisit"],
    expandEdges: ["CAUSED", "DERIVED_FROM", "PRECEDED_BY"],
    hops: 2
  },
  critic: {
    seedTypes: ["Failure", "Skill"],
    expandEdges: ["CONTRADICTS", "DERIVED_FROM", "ABSTRACTS"],
    hops: 2
  },
  memory: {
    seedTypes: ["Entity", "Concept", "Preference", "Intent"],
    expandEdges: ["REFERS_TO", "SIMILAR_TO", "ABSTRACTS", "SUPERSEDES"],
    hops: 2
  }
};

export interface RetrievalAuditEntry {
  agent: AgentName;
  installId: string;
  queryHash: string;
  profile: RetrievalProfileName;
  returnedNodeIds: string[];
  ts: number;
}

export interface HybridRetrieverDeps {
  store: GraphStore;
  embedder: Embedder;
  clock?: () => number;
  audit?: (entry: RetrievalAuditEntry) => void;
  /** Per-hop multiplicative score decay. */
  hopDecay?: number;
  /** Recency half-life in days for the recency factor. */
  recencyHalfLifeDays?: number;
}

export interface RetrieveOptions {
  installId: string;
  query: string;
  profile: RetrievalProfileName;
  agent: AgentName;
  topKSeeds?: number;
  maxNodes?: number;
  tokenBudget?: number;
}

export interface RetrievedSubgraph extends Subgraph {
  scores: Record<string, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class HybridRetriever {
  private readonly store: GraphStore;
  private readonly embedder: Embedder;
  private readonly clock: () => number;
  private readonly audit?: (entry: RetrievalAuditEntry) => void;
  private readonly hopDecay: number;
  private readonly recencyHalfLifeDays: number;

  constructor(deps: HybridRetrieverDeps) {
    this.store = deps.store;
    this.embedder = deps.embedder;
    this.clock = deps.clock ?? (() => Date.now());
    this.audit = deps.audit;
    this.hopDecay = deps.hopDecay ?? 0.6;
    this.recencyHalfLifeDays = deps.recencyHalfLifeDays ?? 30;
  }

  async retrieve(options: RetrieveOptions): Promise<RetrievedSubgraph> {
    const profile = RETRIEVAL_PROFILES[options.profile];
    const topKSeeds = options.topKSeeds ?? 6;
    const maxNodes = options.maxNodes ?? 20;
    const tokenBudget = options.tokenBudget ?? 1500;
    const now = this.clock();

    const queryEmbedding = await this.embedder.embed(options.query);
    const seeds = await this.seed(options.installId, queryEmbedding, profile, topKSeeds);

    // Best path score per node id (seed cosine, decayed by hop + edge weight).
    const pathScore = new Map<string, number>();
    const nodes = new Map<string, KGNode>();
    const edges = new Map<string, KGEdge>();
    let frontier: string[] = [];
    for (const seed of seeds) {
      nodes.set(seed.node.id, seed.node);
      pathScore.set(seed.node.id, Math.max(0.01, seed.score));
      frontier.push(seed.node.id);
    }

    for (let hop = 0; hop < profile.hops && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const parentScore = pathScore.get(nodeId) ?? 0;
        const neighbors = await this.store.neighbors(options.installId, nodeId, {
          edgeTypes: profile.expandEdges,
          direction: "both"
        });
        for (const hit of neighbors) {
          edges.set(hit.edge.id, hit.edge);
          const candidate = parentScore * this.hopDecay * Math.max(0.1, hit.edge.weight);
          const existing = pathScore.get(hit.node.id);
          if (existing === undefined || candidate > existing) {
            pathScore.set(hit.node.id, candidate);
            if (!nodes.has(hit.node.id)) next.push(hit.node.id);
          }
          nodes.set(hit.node.id, hit.node);
        }
      }
      frontier = next;
    }

    // Final re-rank: path score x importance x recency.
    const scored = [...nodes.values()].map((node) => {
      const base = pathScore.get(node.id) ?? 0.01;
      const score = base * node.importance * this.recencyFactor(node, now);
      return { node, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const keptNodes: KGNode[] = [];
    const scores: Record<string, number> = {};
    let usedTokens = 0;
    for (const entry of scored) {
      if (keptNodes.length >= maxNodes) break;
      const cost = estimateTokens(entry.node);
      if (usedTokens + cost > tokenBudget && keptNodes.length > 0) break;
      usedTokens += cost;
      keptNodes.push(entry.node);
      scores[entry.node.id] = entry.score;
    }

    const keptIds = new Set(keptNodes.map((node) => node.id));
    const keptEdges = [...edges.values()].filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));

    await this.store.touch(options.installId, [...keptIds], now);
    this.audit?.({
      agent: options.agent,
      installId: options.installId,
      queryHash: hashQuery(options.query),
      profile: options.profile,
      returnedNodeIds: [...keptIds],
      ts: now
    });

    return { nodes: keptNodes, edges: keptEdges, scores };
  }

  private async seed(
    installId: string,
    queryEmbedding: number[],
    profile: RetrievalProfile,
    topKSeeds: number
  ): Promise<{ node: KGNode; score: number }[]> {
    const hits = await this.store.vectorSearch(installId, queryEmbedding, {
      topK: topKSeeds,
      types: profile.seedTypes
    });
    if (hits.length > 0) {
      return hits;
    }
    // Fallback: no embeddings matched — seed by importance among seed types.
    const fallback = await this.store.listNodes(installId, { types: profile.seedTypes });
    fallback.sort((a, b) => b.importance - a.importance);
    return fallback.slice(0, topKSeeds).map((node) => ({ node, score: 0.2 }));
  }

  private recencyFactor(node: KGNode, now: number): number {
    const ageDays = Math.max(0, (now - node.lastAccessedAt) / DAY_MS);
    return Math.pow(0.5, ageDays / this.recencyHalfLifeDays);
  }
}

const estimateTokens = (node: KGNode): number => {
  const text = `${node.type} ${node.label} ${JSON.stringify(node.properties)}`;
  return Math.ceil(text.length / 4);
};

const hashQuery = (query: string): string => {
  let hash = 0;
  for (let i = 0; i < query.length; i += 1) {
    hash = (hash * 31 + query.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
};
