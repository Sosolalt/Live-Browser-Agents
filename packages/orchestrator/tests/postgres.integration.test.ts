import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { FieldCipher } from "../src/memory/crypto.js";
import { HashEmbedder } from "../src/ports/embedder.js";
import { MemorySystem } from "../src/memory/memorySystem.js";
import { PostgresGraphStore } from "../src/memory/postgresGraphStore.js";
import type { MemoryEvent } from "../src/memory/kgTypes.js";

// Opt-in integration test against a real Postgres + pgvector instance.
// Set DATABASE_URL (e.g. postgres://localhost/kg_test) to run it; otherwise it
// is skipped so the hermetic suite stays green in CI.
const databaseUrl = process.env.DATABASE_URL;
const runner = databaseUrl ? describe : describe.skip;

const EMBED_DIMS = 64;
const SECRET = "test-secret-key-test-secret-key-0001";

runner("PostgresGraphStore (DATABASE_URL)", () => {
  let pool: Pool;
  let system: MemorySystem;
  const installId = `it-install-${Math.floor(Date.now() / 1000)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    const store = new PostgresGraphStore(pool, { dimensions: EMBED_DIMS });
    await store.init();
    system = new MemorySystem({ store, embedder: new HashEmbedder(EMBED_DIMS), cipher: FieldCipher.fromSecret(SECRET) });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM kg_edge WHERE install_id = $1", [installId]);
    await pool.query("DELETE FROM kg_node WHERE install_id = $1", [installId]);
    await pool.end();
  });

  const event = (overrides: Partial<MemoryEvent> & Pick<MemoryEvent, "kind" | "payload">): MemoryEvent => ({
    installId,
    sessionId: "s1",
    ts: Date.now(),
    source: "memory",
    ...overrides
  });

  it("writes typed nodes and retrieves a grounded subgraph via pgvector", async () => {
    await system.recordEvents([
      event({ kind: "preference", source: "form", payload: { key: "shoe", value: "running shoes size 10" } }),
      event({ kind: "observation", source: "perception", payload: { text: "running shoes on sale" } })
    ]);
    const result = await system.retrieve({
      installId,
      query: "running shoes",
      profile: "form",
      agent: "form",
      maxNodes: 5
    });
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("forgets by domain and isolates tenants", async () => {
    await system.recordEvents([event({ kind: "page_visited", source: "perception", payload: { url: "https://shop.test/x", title: "x" } })]);
    const before = await system.export(installId);
    expect(before.nodes.some((node) => node.type === "PageVisit")).toBe(true);
    const removed = await system.forget(installId, { kind: "domain", domain: "shop.test" });
    expect(removed.removed).toBeGreaterThan(0);

    const other = await system.export("nonexistent-install");
    expect(other.nodes).toHaveLength(0);
  });
});
