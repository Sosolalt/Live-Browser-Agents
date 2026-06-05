import { describe, expect, it, vi } from "vitest";
import { createRuntimeOrchestrator } from "../src/background/orchestrator";
import { isPopupToBackgroundMessage } from "../src/shared/schema";

const createChromeMock = (tabUrl = "https://example.com/"): typeof chrome => {
  const storageMap = new Map<string, unknown>();
  return {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined)
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: tabUrl }]),
      sendMessage: vi.fn().mockResolvedValue(undefined)
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue(undefined)
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageMap.get(key) })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.entries(value).forEach(([k, v]) => storageMap.set(k, v));
        }),
        remove: vi.fn(async (key: string) => {
          storageMap.delete(key);
        })
      }
    }
  } as unknown as typeof chrome;
};

const sessionResult = {
  accessToken: "token",
  startupConfig: {
    model: "models/test",
    voice: "TestVoice",
    policyVersion: "v1",
    guardrails: ["safe"],
    liveWebSocketUrl: "wss://example.test/live"
  }
};

describe("adversarial message conformance", () => {
  it("rejects malformed popup execute action envelope", () => {
    expect(
      isPopupToBackgroundMessage({
        kind: "popup.executeAction",
        action: { type: "click", selector: "#delete" },
        idempotencyKey: "id-1",
        userConfirmed: "yes"
      })
    ).toBe(false);
  });

  it("does not re-execute duplicate idempotency actions", async () => {
    vi.stubGlobal("chrome", createChromeMock());
    const sendMessage = (globalThis.chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => sessionResult,
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    const sendResponse = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "dup-1",
        userConfirmed: true
      },
      sendResponse
    );
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "dup-1",
        userConfirmed: true
      },
      sendResponse
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenLastCalledWith({
      ok: true,
      result: {
        requestId: "duplicate",
        duplicate: true
      }
    });
  });

  it("prevents execution when action is cancelled first", async () => {
    vi.stubGlobal("chrome", createChromeMock());
    const sendMessage = globalThis.chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => sessionResult,
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    const sendResponse = vi.fn();
    await orchestrator.onMessage({ kind: "popup.cancelAction", idempotencyKey: "cancel-1" }, sendResponse);
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "cancel-1",
        userConfirmed: true
      },
      sendResponse
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenLastCalledWith({
      ok: false,
      error: "action_cancelled"
    });
  });
});
