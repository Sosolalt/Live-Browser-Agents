import type { OutboundEvent, ResumptionHandle } from "../shared/contracts";
import type { SessionInitResult } from "./session";

export type TransportEvents = {
  onConnected: (handle: ResumptionHandle | null) => void;
  onDisconnected: (reason?: string) => void;
  onFatalError: (message: string) => void;
  onAssistantAudioChunk: (chunk: { sampleRate: number; pcmBase64: string }) => void;
  onPlaybackInterrupted: (reason: "barge_in" | "remote_interrupt") => void;
};

export type RuntimeTransport = {
  connect: (args: {
    session: SessionInitResult;
    resumeFrom?: ResumptionHandle | null;
  }) => Promise<void>;
  disconnect: () => Promise<void>;
  send: (event: OutboundEvent) => Promise<void>;
};

export const createStubTransport = (events: TransportEvents): RuntimeTransport => {
  let connected = false;
  return {
    async connect(_args) {
      connected = true;
      events.onConnected(null);
    },
    async disconnect() {
      if (!connected) return;
      connected = false;
      events.onDisconnected("manual_disconnect");
    },
    async send(event) {
      if (!connected) {
        throw new Error("transport_not_connected");
      }
      if (event.kind === "userTranscript") {
        const payload = event.payload as { text?: string };
        const text = typeof payload.text === "string" ? payload.text : "";
        if (text.length > 0) {
          const silentPcm16 = new Uint8Array(1600);
          const pcmBase64 =
            typeof Buffer !== "undefined"
              ? Buffer.from(silentPcm16).toString("base64")
              : btoa(String.fromCharCode(...silentPcm16));
          events.onAssistantAudioChunk({ sampleRate: 16000, pcmBase64 });
        }
      }
    }
  };
};

type LiveServerMessage = {
  setupComplete?: { sessionId?: string; resumptionToken?: string };
  serverContent?: { modelTurn?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } };
  goAway?: { reason?: string };
  interrupted?: { reason?: string };
};

const parseLiveMessage = (data: string): LiveServerMessage | null => {
  try {
    return JSON.parse(data) as LiveServerMessage;
  } catch {
    return null;
  }
};

const maybeAudioChunk = (
  message: LiveServerMessage
): { sampleRate: number; pcmBase64: string } | null => {
  const parts = message.serverContent?.modelTurn?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const mimeType = part.inlineData?.mimeType;
    const data = part.inlineData?.data;
    if (mimeType?.startsWith("audio/pcm") && typeof data === "string" && data.length > 0) {
      const rateMatch = mimeType.match(/rate=(\d+)/);
      const sampleRate = rateMatch ? Number(rateMatch[1]) : 16000;
      return { sampleRate, pcmBase64: data };
    }
  }
  return null;
};

const toSetupMessage = (session: SessionInitResult, resumeFrom?: ResumptionHandle | null): Record<string, unknown> => ({
  setup: {
    model: session.startupConfig.model,
    generationConfig: {
      responseModalities: ["AUDIO"]
    },
    systemInstruction: {
      parts: session.startupConfig.guardrails.map((guardrail) => ({ text: guardrail }))
    },
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: session.startupConfig.voice }
      }
    },
    sessionResumption: resumeFrom
      ? {
          token: resumeFrom.cursor
        }
      : undefined
  }
});

const toLiveInputMessage = (event: OutboundEvent): Record<string, unknown> | null => {
  if (event.kind === "userTranscript") {
    const text = (event.payload as { text?: string }).text ?? "";
    return {
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true
      }
    };
  }
  if (event.kind === "userAudioChunk") {
    return {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: (event.payload as { mimeType?: string }).mimeType ?? "audio/pcm;rate=16000",
            data: (event.payload as { pcmBase64?: string }).pcmBase64 ?? ""
          }
        ]
      }
    };
  }
  return null;
};

export const createGeminiLiveTransport = (events: TransportEvents): RuntimeTransport => {
  let socket: WebSocket | null = null;
  let setupComplete = false;
  let connectPromise: Promise<void> | null = null;

  const connect = async ({
    session,
    resumeFrom
  }: {
    session: SessionInitResult;
    resumeFrom?: ResumptionHandle | null;
  }): Promise<void> => {
    const liveWebSocketUrl = session.startupConfig.liveWebSocketUrl;
    if (!liveWebSocketUrl) {
      throw new Error("missing_live_websocket_url");
    }

    if (connectPromise) {
      return connectPromise;
    }

    setupComplete = false;
    connectPromise = new Promise<void>((resolve, reject) => {
      try {
        socket = new WebSocket(liveWebSocketUrl, ["Bearer", session.accessToken]);
      } catch (error) {
        reject(error);
        connectPromise = null;
        return;
      }

      socket.onopen = () => {
        socket?.send(JSON.stringify(toSetupMessage(session, resumeFrom)));
      };

      socket.onmessage = (event) => {
        const parsed = typeof event.data === "string" ? parseLiveMessage(event.data) : null;
        if (!parsed) return;

        if ("setupComplete" in parsed && parsed.setupComplete) {
          setupComplete = true;
          events.onConnected(
            parsed.setupComplete.sessionId && parsed.setupComplete.resumptionToken
              ? {
                  sessionId: parsed.setupComplete.sessionId,
                  cursor: parsed.setupComplete.resumptionToken,
                  updatedAtMs: Date.now()
                }
              : null
          );
          resolve();
          connectPromise = null;
        }

        const audioChunk = maybeAudioChunk(parsed);
        if (audioChunk) {
          events.onAssistantAudioChunk(audioChunk);
        }

        if ("interrupted" in parsed && parsed.interrupted) {
          events.onPlaybackInterrupted("remote_interrupt");
        }

        if ("goAway" in parsed && parsed.goAway) {
          events.onDisconnected(parsed.goAway.reason ?? "go_away");
        }
      };

      socket.onclose = () => {
        setupComplete = false;
        events.onDisconnected("socket_closed");
      };

      socket.onerror = () => {
        if (connectPromise) {
          reject(new Error("gemini_socket_error"));
          connectPromise = null;
          return;
        }
        events.onFatalError("gemini_socket_error");
      };
    });

    return connectPromise;
  };

  const disconnect = async (): Promise<void> => {
    if (!socket) return;
    socket.close();
    socket = null;
    setupComplete = false;
  };

  const send = async (event: OutboundEvent): Promise<void> => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !setupComplete) {
      throw new Error("live_transport_not_ready");
    }
    const payload = toLiveInputMessage(event);
    if (!payload) return;
    socket.send(JSON.stringify(payload));
  };

  return { connect, disconnect, send };
};
