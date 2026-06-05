import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundEvent } from "../src/shared/contracts";
import { createGeminiLiveTransport } from "../src/background/transport";

class MockWebSocket {
  static readonly OPEN = 1;
  static instances: MockWebSocket[] = [];

  public readonly url: string;
  public readonly protocols: string[];
  public sent: string[] = [];
  public readyState = 0;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: (() => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
}

const session = {
  accessToken: "token",
  startupConfig: {
    model: "models/test",
    voice: "TestVoice",
    policyVersion: "v1",
    guardrails: ["safe"],
    liveWebSocketUrl: "wss://example.test/live"
  }
};

describe("gemini live transport", () => {
  afterEach(() => {
    MockWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it("sends setup on open and resolves on setupComplete", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    const events = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onFatalError: vi.fn(),
      onAssistantAudioChunk: vi.fn(),
      onPlaybackInterrupted: vi.fn()
    };
    const transport = createGeminiLiveTransport(events);

    const connectPromise = transport.connect({ session, resumeFrom: null });
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    expect(ws.sent[0]).toContain("\"setup\"");

    ws.emitMessage(
      JSON.stringify({
        setupComplete: {
          sessionId: "s1",
          resumptionToken: "r1"
        }
      })
    );
    await connectPromise;
    expect(events.onConnected).toHaveBeenCalledWith({
      sessionId: "s1",
      cursor: "r1",
      updatedAtMs: expect.any(Number)
    });
  });

  it("enforces setupComplete gating before send", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    const transport = createGeminiLiveTransport({
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onFatalError: vi.fn(),
      onAssistantAudioChunk: vi.fn(),
      onPlaybackInterrupted: vi.fn()
    });
    void transport.connect({ session, resumeFrom: null });
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();

    const event: OutboundEvent = {
      id: "e1",
      kind: "userTranscript",
      payload: { text: "hello" },
      createdAtMs: Date.now()
    };
    await expect(transport.send(event)).rejects.toThrow("live_transport_not_ready");
  });

  it("forwards audio/interruption/disconnect server signals", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    const events = {
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onFatalError: vi.fn(),
      onAssistantAudioChunk: vi.fn(),
      onPlaybackInterrupted: vi.fn()
    };
    const transport = createGeminiLiveTransport(events);

    const connectPromise = transport.connect({ session, resumeFrom: null });
    const ws = MockWebSocket.instances[0];
    ws.emitOpen();
    ws.emitMessage(JSON.stringify({ setupComplete: {} }));
    await connectPromise;

    ws.emitMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=16000", data: "AQID" } }]
          }
        }
      })
    );
    ws.emitMessage(JSON.stringify({ interrupted: { reason: "barge_in" } }));
    ws.emitMessage(JSON.stringify({ goAway: { reason: "drain" } }));

    expect(events.onAssistantAudioChunk).toHaveBeenCalledWith({
      sampleRate: 16000,
      pcmBase64: "AQID"
    });
    expect(events.onPlaybackInterrupted).toHaveBeenCalledWith("remote_interrupt");
    expect(events.onDisconnected).toHaveBeenCalledWith("drain");
  });
});
