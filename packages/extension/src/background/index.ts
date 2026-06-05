import { createRuntimeOrchestrator } from "./orchestrator";
import { fetchSessionInitToken } from "./token";
import { createGeminiLiveTransport, createStubTransport, type RuntimeTransport } from "./transport";
import { isContentToBackgroundMessage } from "../shared/schema";

const createTransportWithFallback = (): RuntimeTransport => {
  let active: RuntimeTransport | null = null;

  const transportEvents = {
    onConnected: (handle: { sessionId: string; cursor: string; updatedAtMs: number } | null) => {
      void orchestrator.onConnected(handle);
    },
    onDisconnected: () => {
      orchestrator.onDisconnected();
    },
    onFatalError: (message: string) => {
      orchestrator.onFatalError(message);
    },
    onAssistantAudioChunk: (chunk: { sampleRate: number; pcmBase64: string }) => {
      orchestrator.onAssistantAudioChunk(chunk);
    },
    onPlaybackInterrupted: (reason: "barge_in" | "remote_interrupt") => {
      orchestrator.onPlaybackInterrupted(reason);
    }
  };

  const gemini = createGeminiLiveTransport(transportEvents);
  const stub = createStubTransport(transportEvents);

  return {
    async connect(args) {
      try {
        await gemini.connect(args);
        active = gemini;
      } catch {
        await stub.connect(args);
        active = stub;
      }
    },
    async disconnect() {
      if (!active) return;
      await active.disconnect();
      active = null;
    },
    async send(event) {
      if (!active) {
        throw new Error("no_active_transport");
      }
      await active.send(event);
    }
  };
};

const orchestrator = createRuntimeOrchestrator({
  getToken: fetchSessionInitToken,
  transport: createTransportWithFallback()
});

void orchestrator.initialize();

const isTrustedContentSender = (sender: chrome.runtime.MessageSender): boolean =>
  sender.id === chrome.runtime.id && typeof sender.tab?.id === "number";

const isTrustedPopupSender = (sender: chrome.runtime.MessageSender): boolean => {
  if (sender.id !== chrome.runtime.id) return false;
  if (typeof sender.tab?.id === "number") return false;
  if (typeof sender.url !== "string") return false;
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}/`;
  return sender.url.startsWith(extensionOrigin);
};

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isContentToBackgroundMessage(message)) {
    if (!isTrustedContentSender(sender)) {
      sendResponse({ ok: false, ignored: true, reason: "untrusted_sender" });
      return false;
    }
    void orchestrator.onContentMessage(message).then((accepted) => {
      sendResponse(accepted ? { ok: true } : { ok: false, ignored: true, reason: "unmatched_request" });
    });
    return true;
  }

  if (!isTrustedPopupSender(sender)) {
    sendResponse({ ok: false, ignored: true, reason: "untrusted_sender" });
    return false;
  }

  void orchestrator.onMessage(message, sendResponse);
  return true;
});
