import { Pool } from "pg";
import type { PoolClient } from "pg";
import { toSql } from "pgvector/pg";
import { fromSql } from "pgvector";
import type {
  EdgeDirection,
  EdgeFilter,
  GraphBatch,
  GraphStore,
  NeighborHit,
  NodeFilter,
  VectorHit,
  VectorSearchOptions
} from "./graphStore.js";
import { NATURAL_KEY_PROP } from "./graphStore.js";
import type { EdgeType, KGEdge, KGNode, MemoryTier, NodeType, Subgraph } from "./kgTypes.js";

interface NodeRow {
  install_id: string;
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  sealed: KGNode["sealed"];
  embedding_text: string | null;
  importance: number;
  confidence: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  ttl_ms: string | null;
  tier: string;
  provenance: string;
}

interface EdgeRow {
  install_id: string;
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  weight: number;
  properties: Record<string, unknown>;
  created_at: string;
}

export interface PostgresGraphStoreOptions {
  /** Vector dimension; must match the configured Embedder. */
  dimensions: number;
}

/**
 * Single-transactional-store GraphStore: Postgres + pgvector (embeddings) +
 * JSONB (typed node payloads) + recursive-CTE / adjacency traversal. Every query
 * is scoped by install_id (row-level tenancy); enable Postgres RLS in production
 * for defence in depth. Used only when DATABASE_URL is configured.
 */
export class PostgresGraphStore implements GraphStore {
  private readonly pool: Pool;
  private readonly dimensions: number;
  private initialized: Promise<void> | null = null;

  constructor(pool: Pool, options: PostgresGraphStoreOptions) {
    this.pool = pool;
    this.dimensions = options.dimensions;
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.runMigrations();
    }
    return this.initialized;
  }

  private async runMigrations(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`
        CREATE TABLE IF NOT EXISTS kg_node (
          install_id text NOT NULL,
          id text NOT NULL,
          type text NOT NULL,
          label text NOT NULL,
          properties jsonb NOT NULL DEFAULT '{}'::jsonb,
          sealed jsonb,
          embedding vector(${this.dimensions}),
          importance double precision NOT NULL,
          confidence double precision NOT NULL,
          access_count integer NOT NULL DEFAULT 0,
          created_at bigint NOT NULL,
          updated_at bigint NOT NULL,
          last_accessed_at bigint NOT NULL,
          ttl_ms bigint,
          tier text NOT NULL,
          provenance text NOT NULL DEFAULT '',
          natural_key text,
          PRIMARY KEY (install_id, id)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS kg_edge (
          install_id text NOT NULL,
          id text NOT NULL,
          type text NOT NULL,
          from_id text NOT NULL,
          to_id text NOT NULL,
          weight double precision NOT NULL,
          properties jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at bigint NOT NULL,
          PRIMARY KEY (install_id, id)
        )
      `);
      await client.query("CREATE INDEX IF NOT EXISTS kg_node_type_idx ON kg_node (install_id, type)");
      await client.query("CREATE INDEX IF NOT EXISTS kg_node_natkey_idx ON kg_node (install_id, type, natural_key)");
      await client.query("CREATE INDEX IF NOT EXISTS kg_edge_from_idx ON kg_edge (install_id, from_id)");
      await client.query("CREATE INDEX IF NOT EXISTS kg_edge_to_idx ON kg_edge (install_id, to_id)");
    } finally {
      client.release();
    }
  }

  async upsertNode(node: KGNode): Promise<void> {
    await this.init();
    await this.pool.query(NODE_UPSERT_SQL, nodeParams(node));
  }

  async upsertEdge(edge: KGEdge): Promise<void> {
    await this.init();
    await this.pool.query(EDGE_UPSERT_SQL, edgeParams(edge));
  }

  async applyBatch(installId: string, batch: GraphBatch): Promise<void> {
    await this.init();
    await this.withTransaction(async (client) => {
      for (const node of batch.upsertNodes) {
        await client.query(NODE_UPSERT_SQL, nodeParams(node));
      }
      for (const edge of batch.upsertEdges) {
        await client.query(EDGE_UPSERT_SQL, edgeParams(edge));
      }
      if (batch.deleteEdgeIds && batch.deleteEdgeIds.length > 0) {
        await client.query(`DELETE FROM kg_edge WHERE install_id = $1 AND id = ANY($2)`, [installId, batch.deleteEdgeIds]);
      }
      if (batch.deleteNodeIds && batch.deleteNodeIds.length > 0) {
        await client.query(`DELETE FROM kg_edge WHERE install_id = $1 AND (from_id = ANY($2) OR to_id = ANY($2))`, [
          installId,
          batch.deleteNodeIds
        ]);
        await client.query(`DELETE FROM kg_node WHERE install_id = $1 AND id = ANY($2)`, [installId, batch.deleteNodeIds]);
      }
    });
  }

  async getNode(installId: string, id: string): Promise<KGNode | null> {
    await this.init();
    const result = await this.pool.query<NodeRow>(
      `SELECT *, embedding::text AS embedding_text FROM kg_node WHERE install_id = $1 AND id = $2`,
      [installId, id]
    );
    const row = result.rows[0];
    return row ? mapNode(row) : null;
  }

  async getNodes(installId: string, ids: string[]): Promise<KGNode[]> {
    await this.init();
    if (ids.length === 0) return [];
    const result = await this.pool.query<NodeRow>(
      `SELECT *, embedding::text AS embedding_text FROM kg_node WHERE install_id = $1 AND id = ANY($2)`,
      [installId, ids]
    );
    return result.rows.map(mapNode);
  }

  async listNodes(installId: string, filter: NodeFilter = {}): Promise<KGNode[]> {
    await this.init();
    const conditions = ["install_id = $1"];
    const params: unknown[] = [installId];
    if (filter.types && filter.types.length > 0) {
      params.push(filter.types);
      conditions.push(`type = ANY($${params.length})`);
    }
    if (filter.domain !== undefined) {
      params.push(filter.domain);
      conditions.push(`properties->>'domain' = $${params.length}`);
    }
    if (filter.createdAfter !== undefined) {
      params.push(filter.createdAfter);
      conditions.push(`created_at >= $${params.length}`);
    }
    if (filter.createdBefore !== undefined) {
      params.push(filter.createdBefore);
      conditions.push(`created_at <= $${params.length}`);
    }
    const result = await this.pool.query<NodeRow>(
      `SELECT *, embedding::text AS embedding_text FROM kg_node WHERE ${conditions.join(" AND ")}`,
      params
    );
    return result.rows.map(mapNode);
  }

  async listEdges(installId: string, filter: EdgeFilter = {}): Promise<KGEdge[]> {
    await this.init();
    const conditions = ["install_id = $1"];
    const params: unknown[] = [installId];
    if (filter.from !== undefined) {
      params.push(filter.from);
      conditions.push(`from_id = $${params.length}`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      conditions.push(`to_id = $${params.length}`);
    }
    if (filter.types && filter.types.length > 0) {
      params.push(filter.types);
      conditions.push(`type = ANY($${params.length})`);
    }
    const result = await this.pool.query<EdgeRow>(`SELECT * FROM kg_edge WHERE ${conditions.join(" AND ")}`, params);
    return result.rows.map(mapEdge);
  }

  async neighbors(
    installId: string,
    nodeId: string,
    options: { edgeTypes?: EdgeType[] | undefined; direction?: EdgeDirection } = {}
  ): Promise<NeighborHit[]> {
    await this.init();
    const direction = options.direction ?? "both";
    const conditions = ["install_id = $1"];
    const params: unknown[] = [installId];
    params.push(nodeId);
    if (direction === "out") conditions.push(`from_id = $${params.length}`);
    else if (direction === "in") conditions.push(`to_id = $${params.length}`);
    else conditions.push(`(from_id = $${params.length} OR to_id = $${params.length})`);
    if (options.edgeTypes && options.edgeTypes.length > 0) {
      params.push(options.edgeTypes);
      conditions.push(`type = ANY($${params.length})`);
    }
    const edgeResult = await this.pool.query<EdgeRow>(`SELECT * FROM kg_edge WHERE ${conditions.join(" AND ")}`, params);
    const edges = edgeResult.rows.map(mapEdge);
    const neighborIds = edges.map((edge) => (edge.from === nodeId ? edge.to : edge.from));
    const nodes = await this.getNodes(installId, [...new Set(neighborIds)]);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const hits: NeighborHit[] = [];
    for (const edge of edges) {
      const otherId = edge.from === nodeId ? edge.to : edge.from;
      const node = byId.get(otherId);
      if (node) hits.push({ edge, node });
    }
    return hits;
  }

  async vectorSearch(installId: string, embedding: number[], options: VectorSearchOptions): Promise<VectorHit[]> {
    await this.init();
    const params: unknown[] = [installId, toSql(embedding)];
    const conditions = ["install_id = $1", "embedding IS NOT NULL"];
    if (options.types && options.types.length > 0) {
      params.push(options.types);
      conditions.push(`type = ANY($${params.length})`);
    }
    params.push(options.topK);
    const limitParam = params.length;
    const result = await this.pool.query<NodeRow & { score: number }>(
      `SELECT *, embedding::text AS embedding_text, 1 - (embedding <=> $2) AS score
       FROM kg_node WHERE ${conditions.join(" AND ")}
       ORDER BY embedding <=> $2 ASC LIMIT $${limitParam}`,
      params
    );
    const minScore = options.minScore ?? -Infinity;
    return result.rows
      .filter((row) => Number(row.score) >= minScore)
      .map((row) => ({ node: mapNode(row), score: Number(row.score) }));
  }

  async findByNaturalKey(installId: string, type: NodeType, naturalKey: string): Promise<KGNode | null> {
    await this.init();
    const result = await this.pool.query<NodeRow>(
      `SELECT *, embedding::text AS embedding_text FROM kg_node
       WHERE install_id = $1 AND type = $2 AND natural_key = $3 LIMIT 1`,
      [installId, type, naturalKey]
    );
    const row = result.rows[0];
    return row ? mapNode(row) : null;
  }

  async deleteNodes(installId: string, ids: string[]): Promise<number> {
    await this.init();
    if (ids.length === 0) return 0;
    return this.withTransaction(async (client) => {
      await client.query(`DELETE FROM kg_edge WHERE install_id = $1 AND (from_id = ANY($2) OR to_id = ANY($2))`, [
        installId,
        ids
      ]);
      const result = await client.query(`DELETE FROM kg_node WHERE install_id = $1 AND id = ANY($2)`, [installId, ids]);
      return result.rowCount ?? 0;
    });
  }

  async deleteEdges(installId: string, ids: string[]): Promise<number> {
    await this.init();
    if (ids.length === 0) return 0;
    const result = await this.pool.query(`DELETE FROM kg_edge WHERE install_id = $1 AND id = ANY($2)`, [installId, ids]);
    return result.rowCount ?? 0;
  }

  async touch(installId: string, ids: string[], nowMs: number): Promise<void> {
    await this.init();
    if (ids.length === 0) return;
    await this.pool.query(
      `UPDATE kg_node SET access_count = access_count + 1, last_accessed_at = $3
       WHERE install_id = $1 AND id = ANY($2)`,
      [installId, ids, nowMs]
    );
  }

  async exportAll(installId: string): Promise<Subgraph> {
    await this.init();
    const nodes = await this.listNodes(installId);
    const edgeResult = await this.pool.query<EdgeRow>(`SELECT * FROM kg_edge WHERE install_id = $1`, [installId]);
    return { nodes, edges: edgeResult.rows.map(mapEdge) };
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Convenience factory that owns the pg Pool, so consumers needn't depend on pg. */
export const createPostgresGraphStore = (
  connectionString: string,
  options: PostgresGraphStoreOptions
): PostgresGraphStore => new PostgresGraphStore(new Pool({ connectionString }), options);

const NODE_UPSERT_SQL = `
  INSERT INTO kg_node (install_id, id, type, label, properties, sealed, embedding, importance, confidence,
    access_count, created_at, updated_at, last_accessed_at, ttl_ms, tier, provenance, natural_key)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
  ON CONFLICT (install_id, id) DO UPDATE SET
    type = EXCLUDED.type, label = EXCLUDED.label, properties = EXCLUDED.properties, sealed = EXCLUDED.sealed,
    embedding = EXCLUDED.embedding, importance = EXCLUDED.importance, confidence = EXCLUDED.confidence,
    access_count = EXCLUDED.access_count, updated_at = EXCLUDED.updated_at,
    last_accessed_at = EXCLUDED.last_accessed_at, ttl_ms = EXCLUDED.ttl_ms, tier = EXCLUDED.tier,
    provenance = EXCLUDED.provenance, natural_key = EXCLUDED.natural_key`;

const EDGE_UPSERT_SQL = `
  INSERT INTO kg_edge (install_id, id, type, from_id, to_id, weight, properties, created_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  ON CONFLICT (install_id, id) DO UPDATE SET
    type = EXCLUDED.type, from_id = EXCLUDED.from_id, to_id = EXCLUDED.to_id,
    weight = EXCLUDED.weight, properties = EXCLUDED.properties`;

const nodeParams = (node: KGNode): unknown[] => {
  const naturalKey = typeof node.properties[NATURAL_KEY_PROP] === "string" ? node.properties[NATURAL_KEY_PROP] : null;
  return [
    node.installId,
    node.id,
    node.type,
    node.label,
    JSON.stringify(node.properties),
    node.sealed ? JSON.stringify(node.sealed) : null,
    node.embedding ? toSql(node.embedding) : null,
    node.importance,
    node.confidence,
    node.accessCount,
    node.createdAt,
    node.updatedAt,
    node.lastAccessedAt,
    node.ttlMs,
    node.tier,
    node.provenance,
    naturalKey
  ];
};

const edgeParams = (edge: KGEdge): unknown[] => [
  edge.installId,
  edge.id,
  edge.type,
  edge.from,
  edge.to,
  edge.weight,
  JSON.stringify(edge.properties),
  edge.createdAt
];

const parseEmbedding = (text: string | null): number[] | null => {
  if (!text) return null;
  const parsed = fromSql(text);
  return Array.isArray(parsed) ? parsed : null;
};

const mapNode = (row: NodeRow): KGNode => ({
  id: row.id,
  installId: row.install_id,
  type: row.type as NodeType,
  label: row.label,
  properties: row.properties ?? {},
  sealed: row.sealed ?? null,
  embedding: parseEmbedding(row.embedding_text),
  importance: row.importance,
  confidence: row.confidence,
  accessCount: row.access_count,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
  lastAccessedAt: Number(row.last_accessed_at),
  ttlMs: row.ttl_ms === null ? null : Number(row.ttl_ms),
  tier: row.tier as MemoryTier,
  provenance: row.provenance
});

const mapEdge = (row: EdgeRow): KGEdge => ({
  id: row.id,
  installId: row.install_id,
  type: row.type as EdgeType,
  from: row.from_id,
  to: row.to_id,
  weight: row.weight,
  properties: row.properties ?? {},
  createdAt: Number(row.created_at)
});
