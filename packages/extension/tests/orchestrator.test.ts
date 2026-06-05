import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeOrchestrator } from "../src/background/orchestrator";
import type { OutboundEvent } from "../src/shared/contracts";

const createChromeMock = (tabUrl = "https://example.com/"): typeof chrome => {
  const runtimeSendMessage = vi.fn().mockResolvedValue(undefined);
  const tabsQuery = vi.fn().mockResolvedValue([{ id: 1, url: tabUrl }]);
  const tabsSendMessage = vi.fn().mockResolvedValue(undefined);
  const scriptingExecuteScript = vi.fn().mockResolvedValue(undefined);
  const storageMap = new Map<string, unknown>();

  return {
    runtime: {
      sendMessage: runtimeSendMessage
    },
    tabs: {
      query: tabsQuery,
      sendMessage: tabsSendMessage
    },
    scripting: {
      executeScript: scriptingExecuteScript
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

describe("runtime orchestrator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  it("reconnects after disconnect with backoff timer", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const connect = vi.fn(async () => undefined);
    const send = vi.fn(async (_event: OutboundEvent) => undefined);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect,
        disconnect: async () => undefined,
        send
      }
    });

    await orchestrator.initialize();
    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    expect(connect).toHaveBeenCalledTimes(1);

    orchestrator.onDisconnected();
    await vi.advanceTimersByTimeAsync(1700);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("replays buffered events exactly once after reconnect", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const connect = vi.fn(async () => undefined);
    const send = vi
      .fn<(_: OutboundEvent) => Promise<void>>()
      .mockRejectedValueOnce(new Error("transport_down"))
      .mockResolvedValue(undefined);

    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect,
        disconnect: async () => undefined,
        send
      }
    });

    await orchestrator.initialize();
    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    await orchestrator.onMessage({ kind: "popup.sendTranscript", text: "hello replay buffer" }, vi.fn());
    expect(send).toHaveBeenCalledTimes(1);

    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("schedules reconnect when goAway-style disconnect happens", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const connect = vi.fn(async () => undefined);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    await orchestrator.initialize();
    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    orchestrator.onDisconnected();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect after an explicit stop triggers transport disconnect", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const connect = vi.fn(async () => undefined);
    let orchestratorRef: ReturnType<typeof createRuntimeOrchestrator> | null = null;
    const disconnect = vi.fn(async () => {
      orchestratorRef?.onDisconnected();
    });

    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect,
        disconnect,
        send: async () => undefined
      }
    });
    orchestratorRef = orchestrator;

    await orchestrator.initialize();
    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    await orchestrator.onMessage({ kind: "popup.stopSession" }, vi.fn());
    await vi.advanceTimersByTimeAsync(3_000);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("drops mic chunks when backpressure threshold is exceeded", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    let resolveSend: (() => void) | null = null;
    const send = vi.fn(
      async (_event: OutboundEvent) =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        })
    );
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send
      }
    });

    await orchestrator.initialize();
    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    await orchestrator.onMessage({ kind: "popup.setMicActive", micActive: true }, vi.fn());

    const responses: Array<ReturnType<typeof vi.fn>> = [];
    for (let index = 0; index < 5; index += 1) {
      const sendResponse = vi.fn();
      responses.push(sendResponse);
      void orchestrator.onMessage(
        {
          kind: "popup.micChunk",
          sampleRate: 16000,
          samples: [0, 0.1, -0.1]
        },
        sendResponse
      );
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(responses[4]).toHaveBeenCalledWith({
      ok: true,
      dropped: true,
      reason: "mic_backpressure"
    });
    resolveSend?.();
  });

  it("requires confirmation for high-risk action", async () => {
    const chromeMock = createChromeMock("https://bank.example.com/dashboard");
    vi.stubGlobal("chrome", chromeMock);

    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
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
        action: { type: "click", selector: "#submit-payment" },
        idempotencyKey: "risk-1",
        userConfirmed: false
      },
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "confirmation_required"
    });
  });

  it("blocks actions on browser internal pages", async () => {
    const chromeMock = createChromeMock("chrome://settings");
    vi.stubGlobal("chrome", chromeMock);

    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
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
        idempotencyKey: "blocked-1",
        userConfirmed: true
      },
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "blocked_domain"
    });
  });

  it("does not mark action as duplicate when dispatch fails", async () => {
    const chromeMock = createChromeMock();
    const sendMessageMock = chromeMock.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessageMock.mockRejectedValueOnce(new Error("send_failed")).mockResolvedValue(undefined);
    vi.stubGlobal("chrome", chromeMock);

    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    const firstResponse = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "retryable-1",
        userConfirmed: true
      },
      firstResponse
    );
    expect(firstResponse).toHaveBeenCalledWith({ ok: false, error: "action_dispatch_failed" });

    const secondResponse = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "retryable-1",
        userConfirmed: true
      },
      secondResponse
    );
    expect(secondResponse).toHaveBeenCalledWith({ ok: true, requestId: expect.any(String) });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("ignores unsolicited content action results", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);
    const send = vi.fn(async () => undefined);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send
      }
    });

    const accepted = await orchestrator.onContentMessage({
      kind: "content.actionResult",
      requestId: "forged-request",
      ok: true
    });

    expect(accepted).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("adds snapshot telemetry to outbound domSnapshot events", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);
    const send = vi.fn(async () => undefined);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send
      }
    });

    await orchestrator.onMessage({ kind: "popup.startSession" }, vi.fn());
    await orchestrator.onMessage({ kind: "popup.requestDomSnapshot", goal: "submit payment" }, vi.fn());
    const tabMessage = (chromeMock.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      requestId: string;
    };

    const accepted = await orchestrator.onContentMessage({
      kind: "content.domSnapshotResult",
      requestId: tabMessage.requestId,
      snapshot: {
        url: "https://example.com",
        title: "Example",
        textSample: "sample",
        interactive: [
          { role: "button", label: "Submit", selector: "#submit", confidence: 0.9 },
          { role: "a", label: "Help", selector: "a", confidence: 0.3 }
        ],
        profile: "default",
        appliedSnapshotPolicy: {
          minScoreDefault: 4,
          minConfidenceDefault: 0.6,
          minScoreSensitive: 2,
          minConfidenceSensitive: 0.65,
          policyVersion: "test-v1"
        }
      }
    });

    expect(accepted).toBe(true);
    const domSnapshotEvent = send.mock.calls[0][0] as { kind: string; payload: { telemetry?: Record<string, unknown> } };
    expect(domSnapshotEvent.kind).toBe("domSnapshot");
    expect(domSnapshotEvent.payload.telemetry).toEqual({
      interactiveCount: 2,
      avgConfidence: 0.6,
      lowConfidenceCount: 1,
      profile: "default",
      policyVersion: "test-v1"
    });
  });

  it("expires executed idempotency keys after TTL", async () => {
    const chromeMock = createChromeMock();
    const sendMessageMock = chromeMock.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("chrome", chromeMock);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    const first = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "ttl-executed-1",
        userConfirmed: true
      },
      first
    );
    const duplicate = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "ttl-executed-1",
        userConfirmed: true
      },
      duplicate
    );
    expect(duplicate).toHaveBeenCalledWith({
      ok: true,
      result: { requestId: "duplicate", duplicate: true }
    });

    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    const afterTtl = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "ttl-executed-1",
        userConfirmed: true
      },
      afterTtl
    );
    expect(afterTtl).toHaveBeenCalledWith({ ok: true, requestId: expect.any(String) });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("expires cancelled idempotency keys after TTL", async () => {
    const chromeMock = createChromeMock();
    vi.stubGlobal("chrome", chromeMock);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    await orchestrator.onMessage({ kind: "popup.cancelAction", idempotencyKey: "ttl-cancelled-1" }, vi.fn());

    const blocked = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "ttl-cancelled-1",
        userConfirmed: true
      },
      blocked
    );
    expect(blocked).toHaveBeenCalledWith({ ok: false, error: "action_cancelled" });

    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    const allowed = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#safe-action" },
        idempotencyKey: "ttl-cancelled-1",
        userConfirmed: true
      },
      allowed
    );
    expect(allowed).toHaveBeenCalledWith({ ok: true, requestId: expect.any(String) });
  });

  it("cancels queued action before dispatch", async () => {
    const chromeMock = createChromeMock();
    const sendMessageMock = chromeMock.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    let releaseFirst: (() => void) | null = null;
    sendMessageMock.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        })
    );
    vi.stubGlobal("chrome", chromeMock);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    const firstResponse = vi.fn();
    const secondResponse = vi.fn();
    void orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#slow-action" },
        idempotencyKey: "queue-1",
        userConfirmed: true
      },
      firstResponse
    );
    await vi.advanceTimersByTimeAsync(0);

    void orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#queued-action" },
        idempotencyKey: "queue-2",
        userConfirmed: true
      },
      secondResponse
    );
    await vi.advanceTimersByTimeAsync(0);

    await orchestrator.onMessage({ kind: "popup.cancelAction", idempotencyKey: "queue-2" }, vi.fn());
    expect(secondResponse).toHaveBeenCalledWith({ ok: false, error: "action_cancelled" });

    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstResponse).toHaveBeenCalledWith({ ok: true, requestId: expect.any(String) });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("rejects execute actions when dispatch queue is saturated", async () => {
    const chromeMock = createChromeMock();
    const sendMessageMock = chromeMock.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    let releaseFirstDispatch: (() => void) | null = null;
    sendMessageMock.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          releaseFirstDispatch = resolve;
        })
    );
    vi.stubGlobal("chrome", chromeMock);
    const orchestrator = createRuntimeOrchestrator({
      getToken: async () => ({
        accessToken: "token",
        startupConfig: {
          model: "models/test",
          voice: "TestVoice",
          policyVersion: "v1",
          guardrails: ["safe"],
          liveWebSocketUrl: "wss://example.test/live"
        }
      }),
      transport: {
        connect: async () => undefined,
        disconnect: async () => undefined,
        send: async () => undefined
      }
    });

    const firstResponse = vi.fn();
    void orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#in-flight" },
        idempotencyKey: "queue-saturated-0",
        userConfirmed: true
      },
      firstResponse
    );
    await vi.advanceTimersByTimeAsync(0);

    for (let index = 1; index <= 25; index += 1) {
      void orchestrator.onMessage(
        {
          kind: "popup.executeAction",
          action: { type: "click", selector: `#queued-${index}` },
          idempotencyKey: `queue-saturated-${index}`,
          userConfirmed: true
        },
        vi.fn()
      );
    }
    await vi.advanceTimersByTimeAsync(0);

    const queueFullResponse = vi.fn();
    await orchestrator.onMessage(
      {
        kind: "popup.executeAction",
        action: { type: "click", selector: "#overflow" },
        idempotencyKey: "queue-saturated-overflow",
        userConfirmed: true
      },
      queueFullResponse
    );
    expect(queueFullResponse).toHaveBeenCalledWith({
      ok: false,
      error: "action_queue_full"
    });

    releaseFirstDispatch?.();
    await vi.advanceTimersByTimeAsync(0);
  });
});
