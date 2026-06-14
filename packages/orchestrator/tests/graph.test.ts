import { describe, expect, it } from "vitest";
import { FieldCipher } from "../src/memory/crypto.js";
import { HashEmbedder } from "../src/ports/embedder.js";
import { InMemoryGraphStore } from "../src/memory/inMemoryGraphStore.js";
import { MemorySystem } from "../src/memory/memorySystem.js";
import { SimulatedActionExecutor } from "../src/ports/actionExecutor.js";
import type { DomSnapshot } from "../src/types.js";
import { runOrchestration } from "../src/graph/run.js";

const SECRET = "test-secret-key-test-secret-key-0001";

const makeHarness = (options: { elements?: DomSnapshot["elements"]; forced?: Record<string, { ok?: boolean; observation?: string }> } = {}) => {
  let n = 0;
  const newId = () => `id-${(n += 1)}`;
  const clock = () => 1_700_000_000_000;
  const store = new InMemoryGraphStore();
  const memory = new MemorySystem({
    store,
    embedder: new HashEmbedder(),
    cipher: FieldCipher.fromSecret(SECRET),
    clock,
    newId
  });
  const executor = new SimulatedActionExecutor({
    url: "https://example.test/",
    elements: options.elements ?? [
      { selector: "#search", role: "textbox", label: "Search", confidence: 0.9 },
      { selector: "#submit", role: "button", label: "Submit", confidence: 0.85 }
    ],
    forced: options.forced ?? {}
  });
  return { store, memory, executor, clock, newId };
};

describe("orchestration graph", () => {
  it("runs a search+extract intent to completion with parallel perceive/research join", async () => {
    const h = makeHarness();
    const outcome = await runOrchestration(
      { executor: h.executor, memory: h.memory, clock: h.clock, newId: h.newId },
      { installId: "install-1", sessionId: "session-1", intent: "search for running shoes and extract the results" }
    );

    expect(outcome.status).toBe("done");
    expect(outcome.terminationReason).toBe("completed");
    expect(outcome.tasks.length).toBeGreaterThan(0);
    expect(outcome.tasks.every((task) => task.status === "done")).toBe(true);

    const types = outcome.events.map((event) => event.type);
    expect(types).toContain("run_started");
    expect(types).toContain("plan_created");
    expect(types).toContain("action_result");
    expect(types).toContain("verifier_result");
    expect(types).toContain("memory_write");
    expect(types).toContain("run_finished");

    // Perception and Researcher both contributed before planning.
    expect(outcome.events.some((e) => e.node === "perception")).toBe(true);
    expect(outcome.events.some((e) => e.node === "researcher")).toBe(true);
  });

  it("writes episodic memory the next run can ground research on", async () => {
    const h = makeHarness();
    await runOrchestration(
      { executor: h.executor, memory: h.memory, clock: h.clock, newId: h.newId },
      { installId: "install-1", sessionId: "session-1", intent: "extract the product page" }
    );
    const exported = await h.memory.export("install-1");
    expect(exported.nodes.some((node) => node.type === "PageVisit")).toBe(true);
    expect(exported.nodes.some((node) => node.type === "Intent")).toBe(true);
  });

  it("terminates with critic_veto when an action targets a blocked domain", async () => {
    const h = makeHarness();
    const outcome = await runOrchestration(
      { executor: h.executor, memory: h.memory, clock: h.clock, newId: h.newId },
      { installId: "install-2", sessionId: "session-2", intent: "go to https://paypal.com and pay the invoice" }
    );
    expect(outcome.status).toBe("terminated");
    expect(outcome.terminationReason).toBe("critic_veto");
    expect(outcome.events.some((e) => e.type === "critic_decision")).toBe(true);
  });

  it("requires quorum for high blast-radius actions and fails closed when infeasible", async () => {
    // No button in the snapshot → verifier pre-check vote fails → quorum not met.
    const h = makeHarness({ elements: [{ selector: "#field", role: "textbox", label: "Field", confidence: 0.8 }] });
    const outcome = await runOrchestration(
      { executor: h.executor, memory: h.memory, clock: h.clock, newId: h.newId },
      { installId: "install-3", sessionId: "session-3", intent: "purchase and checkout now" }
    );
    expect(outcome.status).toBe("terminated");
    expect(outcome.terminationReason).toBe("quorum_failed");
    const quorum = outcome.events.find((e) => e.type === "quorum_decision");
    expect(quorum?.data?.approved).toBe(false);
  });

  it("rolls back and replans when the verifier sees a diverged post-state", async () => {
    const h = makeHarness({ forced: { "fill:#search": { ok: false, observation: "field rejected" } } });
    const outcome = await runOrchestration(
      { executor: h.executor, memory: h.memory, clock: h.clock, newId: h.newId, maxAttempts: 2 },
      { installId: "install-4", sessionId: "session-4", intent: "search for blender and extract results" }
    );

    // The failing fill is retried, then given up on; the run still finishes.
    const verifierFails = outcome.events.filter((e) => e.type === "verifier_result" && e.data?.passed === false);
    expect(verifierFails.length).toBeGreaterThanOrEqual(2);
    expect(outcome.events.some((e) => e.data?.rolledBack === true)).toBe(true);
    expect(["done", "terminated"]).toContain(outcome.status);
  });

  it("enforces the step budget", async () => {
    const h = makeHarness();
    const outcome = await runOrchestration(
      { executor: h.executor, memory: h.memory, clock: h.clock, newId: h.newId },
      {
        installId: "install-5",
        sessionId: "session-5",
        intent: "search for a then extract",
        budget: { maxSteps: 1, maxToolCalls: 24, maxCostMicros: 5_000_000 }
      }
    );
    expect(outcome.status).toBe("terminated");
    expect(outcome.terminationReason).toBe("budget_steps");
  });
});
