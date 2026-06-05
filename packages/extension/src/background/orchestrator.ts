import type {
  BackgroundToPopupMessage,
  ConnectionState,
  ContentToBackgroundMessage,
  OutboundEvent,
  PopupToBackgroundMessage,
  ResumptionHandle,
  RuntimeState
} from "../shared/contracts";
import { isPopupToBackgroundMessage } from "../shared/schema";
import { clearReplayBuffer, enqueueReplayEvent, loadReplayBuffer, loadResumptionHandle, persistResumptionHandle } from "./storage";
import type { RuntimeTransport } from "./transport";
import { normalizeMicChunkForTransport } from "./audio";
import type { SessionInitResult } from "./session";
import { isBlockedDomain, requiresUserConfirmation } from "./policy";

type TokenProvider = () => Promise<SessionInitResult>;

type RuntimeDeps = {
  getToken: TokenProvider;
  transport: RuntimeTransport;
};

type QueueDispatchResult =
  | { ok: true; requestId: string }
  | { ok: false; error: "action_cancelled" | "action_dispatch_failed" };

type PendingActionDispatch = {
  requestId: string;
  idempotencyKey: string;
  action: { type: "click"; selector: string };
  resolve: (result: QueueDispatchResult) => void;
  queuedAtMs: number;
};

const createInitialState = (): RuntimeState => ({
  connectionState: "idle",
  transcript: "",
  micActive: false
});

const broadcastToRuntime = (message: BackgroundToPopupMessage): void => {
  chrome.runtime.sendMessage(message).catch(() => undefined);
};

const toRuntimeStateMessage = (state: RuntimeState): BackgroundToPopupMessage => ({
  kind: "background.runtimeState",
  state
});

const buildOutboundEvent = (kind: OutboundEvent["kind"], payload: unknown): OutboundEvent => ({
  id: crypto.randomUUID(),
  kind,
  payload,
  createdAtMs: Date.now()
});

const summarizeSnapshotTelemetry = (snapshot: {
  interactive?: Array<{ confidence?: number }>;
  profile?: string;
  appliedSnapshotPolicy?: { policyVersion?: string };
}): {
  interactiveCount: number;
  avgConfidence: number;
  lowConfidenceCount: number;
  profile: string;
  policyVersion: string;
} => {
  const interactive = Array.isArray(snapshot.interactive) ? snapshot.interactive : [];
  const confidenceValues = interactive
    .map((item) => (typeof item.confidence === "number" ? item.confidence : null))
    .filter((value): value is number => value !== null);
  const avgConfidence =
    confidenceValues.length === 0
      ? 0
      : Number((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(3));
  const lowConfidenceCount = confidenceValues.filter((value) => value < 0.5).length;
  return {
    interactiveCount: interactive.length,
    avgConfidence,
    lowConfidenceCount,
    profile: typeof snapshot.profile === "string" ? snapshot.profile : "unknown",
    policyVersion:
      typeof snapshot.appliedSnapshotPolicy?.policyVersion === "string"
        ? snapshot.appliedSnapshotPolicy.policyVersion
        : "unknown"
  };
};

export const createRuntimeOrchestrator = (deps: RuntimeDeps) => {
  let state = createInitialState();
  let resumptionHandle: ResumptionHandle | null = null;
  let currentSnapshotPolicy: SessionInitResult["startupConfig"]["snapshotPolicy"] | undefined;
  const executedActionKeys = new Map<string, number>();
  const cancelledActionKeys = new Map<string, number>();
  const pendingContentRequests = new Map<string, { kind: "domSnapshot" | "actionResult"; createdAtMs: number }>();
  const inFlightActionsByRequestId = new Map<string, string>();
  const actionDispatchQueue: PendingActionDispatch[] = [];
  let processingActionQueue = false;
  let reconnectAttempt = 0;
  let reconnectTimer: number | null = null;
  let manualStopRequested = false;
  let inFlightMicChunks = 0;
  const MAX_IN_FLIGHT_MIC_CHUNKS = 4;
  const MAX_QUEUED_ACTIONS = 25;
  const IDEMPOTENCY_KEY_TTL_MS = 5 * 60_000;
  const PENDING_REQUEST_TTL_MS = 60_000;

  const cleanupExpiredEntries = (): void => {
    const nowMs = Date.now();
    for (const [key, expiresAtMs] of executedActionKeys.entries()) {
      if (expiresAtMs <= nowMs) executedActionKeys.delete(key);
    }
    for (const [key, expiresAtMs] of cancelledActionKeys.entries()) {
      if (expiresAtMs <= nowMs) cancelledActionKeys.delete(key);
    }
    for (const [requestId, request] of pendingContentRequests.entries()) {
      if (request.createdAtMs + PENDING_REQUEST_TTL_MS <= nowMs) {
        pendingContentRequests.delete(requestId);
        const actionKey = inFlightActionsByRequestId.get(requestId);
        if (actionKey) inFlightActionsByRequestId.delete(requestId);
      }
    }
    for (let index = actionDispatchQueue.length - 1; index >= 0; index -= 1) {
      if (actionDispatchQueue[index].queuedAtMs + PENDING_REQUEST_TTL_MS <= nowMs) {
        const [expired] = actionDispatchQueue.splice(index, 1);
        expired.resolve({ ok: false, error: "action_dispatch_failed" });
      }
    }
  };

  const processActionQueue = async (): Promise<void> => {
    if (processingActionQueue) return;
    processingActionQueue = true;
    while (actionDispatchQueue.length > 0) {
      const next = actionDispatchQueue.shift();
      if (!next) break;

      cleanupExpiredEntries();
      if (cancelledActionKeys.has(next.idempotencyKey)) {
        next.resolve({ ok: false, error: "action_cancelled" });
        continue;
      }

      try {
        await sendToActiveTab({
          kind: "background.executeAction",
          requestId: next.requestId,
          action: next.action,
          idempotencyKey: next.idempotencyKey
        });
      } catch {
        next.resolve({ ok: false, error: "action_dispatch_failed" });
        continue;
      }

      executedActionKeys.set(next.idempotencyKey, Date.now() + IDEMPOTENCY_KEY_TTL_MS);
      inFlightActionsByRequestId.set(next.requestId, next.idempotencyKey);
      pendingContentRequests.set(next.requestId, { kind: "actionResult", createdAtMs: Date.now() });
      next.resolve({ ok: true, requestId: next.requestId });
    }
    processingActionQueue = false;
  };

  const setState = (nextState: ConnectionState, extras?: Partial<RuntimeState>): void => {
    state = { ...state, connectionState: nextState, ...extras };
    broadcastToRuntime(toRuntimeStateMessage(state));
  };

  const setError = (message: string): void => {
    setState("error", { lastError: message });
    broadcastToRuntime({ kind: "background.error", message });
  };

  const replayBufferedEvents = async (): Promise<void> => {
    const buffered = await loadReplayBuffer();
    for (const event of buffered) {
      await deps.transport.send(event);
    }
    await clearReplayBuffer();
  };

  const start = async (): Promise<void> => {
    try {
      if (state.connectionState === "ready" || state.connectionState === "connecting") return;
      manualStopRequested = false;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setState(state.connectionState === "idle" ? "fetchingToken" : "reconnecting");
      const session = await deps.getToken();
      currentSnapshotPolicy = session.startupConfig.snapshotPolicy;
      setState("connecting");
      await deps.transport.connect({ session, resumeFrom: resumptionHandle });
      setState("setupPending");
      await replayBufferedEvents();
      reconnectAttempt = 0;
      setState("ready");
    } catch (error) {
      setError(error instanceof Error ? error.message : "unknown_start_error");
    }
  };

  const stop = async (): Promise<void> => {
    manualStopRequested = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    await deps.transport.disconnect();
    broadcastToRuntime({ kind: "background.playbackInterrupted", reason: "session_stopped" });
    setState("stopped");
  };

  const handleOutboundEvent = async (event: OutboundEvent): Promise<void> => {
    if (state.connectionState !== "ready") {
      await enqueueReplayEvent(event);
      return;
    }
    try {
      await deps.transport.send(event);
    } catch {
      await enqueueReplayEvent(event);
      setState("reconnecting");
    }
  };

  const getActiveTabId = async (): Promise<number> => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (typeof tabId !== "number") {
      throw new Error("no_active_tab");
    }
    return tabId;
  };

  const getActiveTabUrl = async (): Promise<string> => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.url ?? "";
  };

  const sendToActiveTab = async (message: unknown): Promise<void> => {
    const tabId = await getActiveTabId();
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/index.js"]
    });
    await chrome.tabs.sendMessage(tabId, message);
  };

  const initialize = async (): Promise<void> => {
    resumptionHandle = await loadResumptionHandle();
    setState("idle");
  };

  const onConnected = async (handle: ResumptionHandle | null): Promise<void> => {
    resumptionHandle = handle;
    await persistResumptionHandle(handle);
    setState("ready");
  };

  const onDisconnected = (): void => {
    if (state.connectionState === "stopped" || manualStopRequested) return;
    setState("reconnecting");
    const baseDelayMs = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
    const jitterMs = Math.floor(Math.random() * 500);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start();
    }, baseDelayMs + jitterMs) as unknown as number;
  };

  const onFatalError = (message: string): void => {
    setError(message);
  };

  const onMessage = async (message: unknown, sendResponse: (response?: unknown) => void): Promise<boolean> => {
    cleanupExpiredEntries();
    if (!isPopupToBackgroundMessage(message)) return false;
    const request = message as PopupToBackgroundMessage;
    if (request.kind === "popup.getRuntimeState") {
      sendResponse({ ok: true, state });
      return true;
    }
    if (request.kind === "popup.startSession") {
      await start();
      sendResponse({ ok: true, state });
      return true;
    }
    if (request.kind === "popup.stopSession") {
      await stop();
      sendResponse({ ok: true, state });
      return true;
    }
    if (request.kind === "popup.setMicActive") {
      setState(state.connectionState, { micActive: request.micActive });
      if (request.micActive) {
        broadcastToRuntime({ kind: "background.playbackInterrupted", reason: "barge_in" });
      }
      sendResponse({ ok: true, state });
      return true;
    }
    if (request.kind === "popup.bargeIn") {
      broadcastToRuntime({ kind: "background.playbackInterrupted", reason: "barge_in" });
      sendResponse({ ok: true });
      return true;
    }
    if (request.kind === "popup.micChunk") {
      if (!state.micActive) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }
      if (inFlightMicChunks >= MAX_IN_FLIGHT_MIC_CHUNKS) {
        sendResponse({ ok: true, dropped: true, reason: "mic_backpressure" });
        return true;
      }
      inFlightMicChunks += 1;
      try {
        await handleOutboundEvent(
          buildOutboundEvent("userAudioChunk", normalizeMicChunkForTransport(request.samples, request.sampleRate))
        );
        sendResponse({ ok: true });
      } finally {
        inFlightMicChunks = Math.max(0, inFlightMicChunks - 1);
      }
      return true;
    }
    if (request.kind === "popup.sendTranscript") {
      setState(state.connectionState, { transcript: request.text });
      await handleOutboundEvent(buildOutboundEvent("userTranscript", { text: request.text }));
      sendResponse({ ok: true, state });
      return true;
    }
    if (request.kind === "popup.requestDomSnapshot") {
      const requestId = crypto.randomUUID();
      await sendToActiveTab({
        kind: "background.requestDomSnapshot",
        requestId,
        goal: request.goal,
        snapshotPolicy: currentSnapshotPolicy
      });
      pendingContentRequests.set(requestId, { kind: "domSnapshot", createdAtMs: Date.now() });
      sendResponse({ ok: true, requestId });
      return true;
    }
    if (request.kind === "popup.executeAction") {
      if (cancelledActionKeys.has(request.idempotencyKey)) {
        sendResponse({
          ok: false,
          error: "action_cancelled"
        });
        return true;
      }
      if (executedActionKeys.has(request.idempotencyKey)) {
        sendResponse({
          ok: true,
          result: {
            requestId: "duplicate",
            duplicate: true
          }
        });
        return true;
      }
      const activeTabUrl = await getActiveTabUrl();
      if (isBlockedDomain(activeTabUrl)) {
        sendResponse({
          ok: false,
          error: "blocked_domain"
        });
        return true;
      }
      if (requiresUserConfirmation(activeTabUrl, request.action.selector) && !request.userConfirmed) {
        sendResponse({
          ok: false,
          error: "confirmation_required"
        });
        return true;
      }
      if (actionDispatchQueue.length >= MAX_QUEUED_ACTIONS) {
        sendResponse({
          ok: false,
          error: "action_queue_full"
        });
        return true;
      }
      const requestId = crypto.randomUUID();
      const result = await new Promise<QueueDispatchResult>((resolve) => {
        actionDispatchQueue.push({
          requestId,
          idempotencyKey: request.idempotencyKey,
          action: request.action,
          resolve,
          queuedAtMs: Date.now()
        });
        void processActionQueue();
      });
      sendResponse(result);
      return true;
    }
    if (request.kind === "popup.cancelAction") {
      cancelledActionKeys.set(request.idempotencyKey, Date.now() + IDEMPOTENCY_KEY_TTL_MS);
      for (let index = actionDispatchQueue.length - 1; index >= 0; index -= 1) {
        const pending = actionDispatchQueue[index];
        if (pending.idempotencyKey === request.idempotencyKey) {
          actionDispatchQueue.splice(index, 1);
          pending.resolve({ ok: false, error: "action_cancelled" });
        }
      }
      const requestId = crypto.randomUUID();
      await sendToActiveTab({
        kind: "background.cancelAction",
        requestId,
        idempotencyKey: request.idempotencyKey
      });
      sendResponse({ ok: true, requestId });
      return true;
    }
    return false;
  };

  const onContentMessage = async (message: ContentToBackgroundMessage): Promise<boolean> => {
    cleanupExpiredEntries();
    const pendingRequest = pendingContentRequests.get(message.requestId);
    if (!pendingRequest) return false;
    if (message.kind === "content.domSnapshotResult") {
      if (pendingRequest.kind !== "domSnapshot") return false;
      pendingContentRequests.delete(message.requestId);
      const telemetry = summarizeSnapshotTelemetry(message.snapshot);
      await handleOutboundEvent(
        buildOutboundEvent("domSnapshot", {
          requestId: message.requestId,
          snapshot: message.snapshot,
          telemetry
        })
      );
      return true;
    }
    if (pendingRequest.kind !== "actionResult") return false;
    pendingContentRequests.delete(message.requestId);
    inFlightActionsByRequestId.delete(message.requestId);
    await handleOutboundEvent(
      buildOutboundEvent("uiActionResult", {
        requestId: message.requestId,
        ok: message.ok,
        reason: message.reason,
        idempotencyKey: message.idempotencyKey
      })
    );
    return true;
  };

  const onAssistantAudioChunk = (chunk: { sampleRate: number; pcmBase64: string }): void => {
    broadcastToRuntime({
      kind: "background.assistantAudioChunk",
      sampleRate: chunk.sampleRate,
      pcmBase64: chunk.pcmBase64
    });
  };

  const onPlaybackInterrupted = (reason: "barge_in" | "remote_interrupt"): void => {
    broadcastToRuntime({ kind: "background.playbackInterrupted", reason });
  };

  return {
    initialize,
    onConnected,
    onDisconnected,
    onFatalError,
    onMessage,
    onContentMessage,
    onAssistantAudioChunk,
    onPlaybackInterrupted
  };
};
