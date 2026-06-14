import { describe, expect, it } from "vitest";
import { FieldCipher } from "../src/memory/crypto.js";
import { PiiGate } from "../src/memory/pii.js";
import { HashEmbedder } from "../src/ports/embedder.js";
import { InMemoryGraphStore } from "../src/memory/inMemoryGraphStore.js";
import { MemorySystem } from "../src/memory/memorySystem.js";
import type { MemoryAuditEvent } from "../src/memory/memorySystem.js";
import type { MemoryEvent } from "../src/memory/kgTypes.js";

const SECRET = "test-secret-key-test-secret-key-0001";

const makeSystem = (audit?: (event: MemoryAuditEvent) => void) => {
  let n = 0;
  const newId = () => `id-${(n += 1)}`;
  let now = 1_700_000_000_000;
  const clock = () => now;
  const store = new InMemoryGraphStore();
  const system = new MemorySystem({
    store,
    embedder: new HashEmbedder(),
    cipher: FieldCipher.fromSecret(SECRET),
    clock,
    newId,
    audit
  });
  return { store, system, setNow: (value: number) => (now = value), clock };
};

const event = (overrides: Partial<MemoryEvent> & Pick<MemoryEvent, "kind" | "payload">): MemoryEvent => ({
  installId: "install-1",
  sessionId: "session-1",
  ts: 1_700_000_000_000,
  source: "memory",
  ...overrides
});

describe("PII gate", () => {
  it("redacts credentials, seals financial fields, hashes contacts", () => {
    const result = new PiiGate().scan({
      username: "alice",
      password: "hunter2",
      card: "4111 1111 1111 1111",
      email: "alice@example.com"
    });
    expect(result.safeProperties.username).toBe("alice");
    expect(result.safeProperties.password).toBe("[redacted]");
    expect(result.safeProperties.card).toBe("[sealed]");
    expect(result.sealable.card).toContain("4111");
    expect(result.safeProperties.email).toBeUndefined();
    expect(result.safeProperties.email_hash).toBeTypeOf("string");
    expect(result.sensitiveValues).toContain("hunter2");
  });
});

describe("FieldCipher", () => {
  it("seals and opens per-install, and isolates installs", () => {
    const cipher = FieldCipher.fromSecret(SECRET);
    const sealed = cipher.seal("install-1", "secret-value");
    expect(cipher.open("install-1", sealed)).toBe("secret-value");
    expect(() => cipher.open("install-2", sealed)).toThrow();
  });
});

describe("memory write path", () => {
  it("builds typed nodes, dedupes by natural key, and extracts entities", async () => {
    const { system, store } = makeSystem();
    await system.recordEvents([
      event({ kind: "session_started", payload: { sessionId: "session-1" } }),
      event({ kind: "intent_captured", source: "planner", payload: { text: "check order 1234 for alice@example.com" } }),
      event({ kind: "page_visited", source: "perception", payload: { url: "https://shop.test/orders", title: "Orders" } })
    ]);
    // Re-emitting the session is idempotent via the natural key.
    await system.recordEvents([event({ kind: "session_started", payload: { sessionId: "session-1" } })]);

    const exported = await store.exportAll("install-1");
    const types = exported.nodes.map((node) => node.type);
    expect(types.filter((type) => type === "Session")).toHaveLength(1);
    expect(types).toContain("Intent");
    expect(types).toContain("PageVisit");
    expect(types).toContain("Domain");
    expect(exported.nodes.some((node) => node.type === "Entity" && node.properties.entityType === "Order")).toBe(true);
    expect(exported.nodes.some((node) => node.type === "Entity" && node.properties.entityType === "Account")).toBe(true);
    // The email must never appear in plaintext anywhere in the graph.
    const dump = JSON.stringify(exported);
    expect(dump).not.toContain("alice@example.com");
  });

  it("supersedes a contradicting preference and retains history", async () => {
    const { system, store } = makeSystem();
    await system.recordEvents([event({ kind: "preference", source: "form", payload: { key: "theme", value: "light" } })]);
    await system.recordEvents([event({ kind: "preference", source: "form", payload: { key: "theme", value: "dark" } })]);
    const prefs = (await store.exportAll("install-1")).nodes.filter((node) => node.type === "Preference");
    expect(prefs).toHaveLength(2);
    const superseded = prefs.filter((node) => node.properties.superseded === true);
    expect(superseded).toHaveLength(1);
    const edges = (await store.exportAll("install-1")).edges;
    expect(edges.some((edge) => edge.type === "SUPERSEDES")).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("never returns one install's nodes to another", async () => {
    const { system, store } = makeSystem();
    await system.recordEvents([event({ installId: "install-A", kind: "preference", source: "form", payload: { key: "k", value: "a" } })]);
    await system.recordEvents([event({ installId: "install-B", kind: "preference", source: "form", payload: { key: "k", value: "b" } })]);
    const a = await store.exportAll("install-A");
    const b = await store.exportAll("install-B");
    expect(a.nodes).toHaveLength(1);
    expect(b.nodes).toHaveLength(1);
    expect(a.nodes[0].label).toBe("a");
    expect(b.nodes[0].label).toBe("b");
  });
});

describe("hybrid retriever", () => {
  it("seeds by vector, expands k-hop, audits, and respects the node budget", async () => {
    const audits: MemoryAuditEvent[] = [];
    const { system } = makeSystem((e) => audits.push(e));
    await system.recordEvents([
      event({ kind: "preference", source: "form", payload: { key: "shoe-size", value: "running shoes size 10" } }),
      event({ kind: "observation", source: "perception", payload: { text: "running shoes are on sale" } })
    ]);
    const result = await system.retrieve({
      installId: "install-1",
      query: "running shoes",
      profile: "form",
      agent: "form",
      maxNodes: 5
    });
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes.length).toBeLessThanOrEqual(5);
    expect(audits.some((a) => a.type === "retrieval")).toBe(true);
  });
});

describe("consolidation", () => {
  it("promotes a repeated successful task into a Skill", async () => {
    const { system, store } = makeSystem();
    for (const sid of ["s1", "s2"]) {
      await system.recordEvents([
        event({ sessionId: sid, kind: "task_planned", source: "planner", payload: { taskId: `${sid}-t`, description: "search for shoes", status: "done" } })
      ]);
    }
    const report = await system.consolidate("install-1");
    expect(report.skillsPromoted).toBeGreaterThanOrEqual(1);
    const skills = (await store.exportAll("install-1")).nodes.filter((node) => node.type === "Skill");
    expect(skills.length).toBeGreaterThanOrEqual(1);
  });

  it("compacts a session's actions into an episode and cools the residue", async () => {
    const { system, store } = makeSystem();
    await system.recordEvents([
      event({ kind: "session_started", payload: { sessionId: "session-1" } }),
      event({ kind: "action_taken", source: "navigator", payload: { kind: "click", target: "#a", summary: "a" } }),
      event({ kind: "action_taken", source: "navigator", payload: { kind: "click", target: "#b", summary: "b" } }),
      event({ kind: "action_taken", source: "navigator", payload: { kind: "click", target: "#c", summary: "c" } })
    ]);
    const created = await system.consolidation.compactEpisodes("install-1", { episodeMinActions: 3 });
    expect(created).toBe(1);
    const nodes = (await store.exportAll("install-1")).nodes;
    expect(nodes.some((node) => node.type === "Observation" && node.properties.episode === true)).toBe(true);
    expect(nodes.filter((node) => node.type === "Action").every((node) => node.tier === "cold")).toBe(true);
  });

  it("cools and purges decayed nodes past their TTL", async () => {
    const { system, store } = makeSystem();
    await system.recordEvents([event({ kind: "page_visited", source: "perception", payload: { url: "https://stale.test/x", title: "x" } })]);
    // Far in the future: well beyond a PageVisit TTL.
    const future = 1_700_000_000_000 + 400 * 24 * 60 * 60 * 1000;
    const cooled = await system.consolidate("install-1", { nowMs: future });
    expect(cooled.nodesCooled).toBeGreaterThan(0);
    // Second pass: cold + expired -> purge.
    const purged = await system.consolidate("install-1", { nowMs: future });
    expect(purged.nodesPurged).toBeGreaterThan(0);
    const remaining = (await store.exportAll("install-1")).nodes.filter((node) => node.type === "PageVisit");
    expect(remaining).toHaveLength(0);
  });
});

describe("privacy", () => {
  it("exports with unsealing, forgets by domain, and pauses recording", async () => {
    const { system, store } = makeSystem();
    await system.recordEvents([
      event({ kind: "preference", source: "form", payload: { key: "card", value: "4111 1111 1111 1111" } }),
      event({ kind: "page_visited", source: "perception", payload: { url: "https://shop.test/x", title: "x" } })
    ]);

    const sealedExport = await system.export("install-1");
    const card = sealedExport.nodes.find((node) => node.type === "Preference" && node.properties.value === "[sealed]");
    expect(card).toBeDefined();
    expect(card?.revealed).toBeUndefined();

    const unsealed = await system.export("install-1", { unseal: true });
    const revealedCard = unsealed.nodes.find((node) => node.revealed);
    expect(revealedCard?.revealed?.value).toContain("4111");

    const forget = await system.forget("install-1", { kind: "domain", domain: "shop.test" });
    expect(forget.removed).toBeGreaterThan(0);
    expect((await store.exportAll("install-1")).nodes.some((node) => node.type === "PageVisit")).toBe(false);

    system.setPaused("install-1", true);
    await system.recordEvents([event({ kind: "preference", source: "form", payload: { key: "x", value: "y" } })]);
    expect((await store.exportAll("install-1")).nodes.some((node) => node.label === "y")).toBe(false);
  });
});
