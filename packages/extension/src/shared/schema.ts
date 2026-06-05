import type {
  BackgroundToContentMessage,
  ContentToBackgroundMessage,
  PopupToBackgroundMessage
} from "./contracts";

const popupKinds = new Set<string>([
  "popup.getRuntimeState",
  "popup.startSession",
  "popup.stopSession",
  "popup.setMicActive",
  "popup.bargeIn",
  "popup.micChunk",
  "popup.sendTranscript",
  "popup.requestDomSnapshot",
  "popup.cancelAction",
  "popup.executeAction"
]);

const contentKinds = new Set<string>(["background.requestDomSnapshot", "background.executeAction", "background.cancelAction"]);

export const isPopupToBackgroundMessage = (value: unknown): value is PopupToBackgroundMessage => {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !popupKinds.has(kind)) return false;
  if (kind === "popup.setMicActive") return typeof (value as { micActive?: unknown }).micActive === "boolean";
  if (kind === "popup.bargeIn") return true;
  if (kind === "popup.micChunk") {
    const samples = (value as { samples?: unknown }).samples;
    return (
      typeof (value as { sampleRate?: unknown }).sampleRate === "number" &&
      Array.isArray(samples) &&
      samples.every((sample) => typeof sample === "number")
    );
  }
  if (kind === "popup.sendTranscript") return typeof (value as { text?: unknown }).text === "string";
  if (kind === "popup.requestDomSnapshot") return typeof (value as { goal?: unknown }).goal === "string";
  if (kind === "popup.cancelAction") return typeof (value as { idempotencyKey?: unknown }).idempotencyKey === "string";
  if (kind === "popup.executeAction") {
    const action = (value as { action?: unknown }).action;
    return (
      !!action &&
      typeof action === "object" &&
      (action as { type?: unknown }).type === "click" &&
      typeof (action as { selector?: unknown }).selector === "string" &&
      typeof (value as { idempotencyKey?: unknown }).idempotencyKey === "string" &&
      typeof (value as { userConfirmed?: unknown }).userConfirmed === "boolean"
    );
  }
  return true;
};

export const isBackgroundToContentMessage = (value: unknown): value is BackgroundToContentMessage => {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !contentKinds.has(kind)) return false;
  const requestId = (value as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return false;
  if (kind === "background.requestDomSnapshot") {
    const goal = (value as { goal?: unknown }).goal;
    if (typeof goal !== "string") return false;
    const snapshotPolicy = (value as { snapshotPolicy?: unknown }).snapshotPolicy;
    if (!snapshotPolicy) return true;
    if (typeof snapshotPolicy !== "object") return false;
    const policy = snapshotPolicy as Record<string, unknown>;
    return (
      typeof policy.minScoreDefault === "number" &&
      typeof policy.minConfidenceDefault === "number" &&
      typeof policy.minScoreSensitive === "number" &&
      typeof policy.minConfidenceSensitive === "number" &&
      (typeof policy.policyVersion === "undefined" || typeof policy.policyVersion === "string")
    );
  }
  if (kind === "background.cancelAction") return typeof (value as { idempotencyKey?: unknown }).idempotencyKey === "string";
  const action = (value as { action?: unknown }).action;
  return (
    !!action &&
    typeof action === "object" &&
    (action as { type?: unknown }).type === "click" &&
    typeof (action as { selector?: unknown }).selector === "string" &&
    typeof (value as { idempotencyKey?: unknown }).idempotencyKey === "string"
  );
};

export const isContentToBackgroundMessage = (value: unknown): value is ContentToBackgroundMessage => {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "content.domSnapshotResult" && kind !== "content.actionResult") return false;
  if (typeof (value as { requestId?: unknown }).requestId !== "string") return false;
  if (kind === "content.domSnapshotResult") {
    const snapshot = (value as { snapshot?: unknown }).snapshot;
    return (
      !!snapshot &&
      typeof snapshot === "object" &&
      typeof (snapshot as { url?: unknown }).url === "string" &&
      typeof (snapshot as { title?: unknown }).title === "string" &&
      typeof (snapshot as { textSample?: unknown }).textSample === "string" &&
      Array.isArray((snapshot as { interactive?: unknown }).interactive)
    );
  }
  const ok = (value as { ok?: unknown }).ok;
  return typeof ok === "boolean";
};
