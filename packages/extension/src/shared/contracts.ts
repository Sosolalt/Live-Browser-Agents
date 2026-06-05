export const connectionStates = [
  "idle",
  "fetchingToken",
  "connecting",
  "setupPending",
  "ready",
  "reconnecting",
  "stopped",
  "error"
] as const;

export type ConnectionState = (typeof connectionStates)[number];

export type RuntimeState = {
  connectionState: ConnectionState;
  transcript: string;
  micActive: boolean;
  lastError?: string;
};

export type ResumptionHandle = {
  sessionId: string;
  cursor: string;
  updatedAtMs: number;
};

export type OutboundEvent = {
  id: string;
  kind: "userTranscript" | "domSnapshot" | "uiActionResult" | "userAudioChunk";
  payload: unknown;
  createdAtMs: number;
};

export type PopupToBackgroundMessage =
  | { kind: "popup.getRuntimeState" }
  | { kind: "popup.startSession" }
  | { kind: "popup.stopSession" }
  | { kind: "popup.setMicActive"; micActive: boolean }
  | { kind: "popup.bargeIn" }
  | { kind: "popup.micChunk"; sampleRate: number; samples: number[] }
  | { kind: "popup.sendTranscript"; text: string }
  | { kind: "popup.requestDomSnapshot"; goal: string }
  | { kind: "popup.cancelAction"; idempotencyKey: string }
  | {
      kind: "popup.executeAction";
      action: { type: "click"; selector: string };
      idempotencyKey: string;
      userConfirmed: boolean;
    };

export type SnapshotPolicyConfig = {
  minScoreDefault: number;
  minConfidenceDefault: number;
  minScoreSensitive: number;
  minConfidenceSensitive: number;
  policyVersion?: string;
};

export type BackgroundToPopupMessage =
  | { kind: "background.runtimeState"; state: RuntimeState }
  | { kind: "background.error"; message: string }
  | { kind: "background.assistantAudioChunk"; sampleRate: number; pcmBase64: string }
  | { kind: "background.playbackInterrupted"; reason: "barge_in" | "remote_interrupt" | "session_stopped" };

export type BackgroundToContentMessage =
  | {
      kind: "background.requestDomSnapshot";
      requestId: string;
      goal: string;
      snapshotPolicy?: SnapshotPolicyConfig;
    }
  | { kind: "background.cancelAction"; requestId: string; idempotencyKey: string }
  | {
      kind: "background.executeAction";
      requestId: string;
      action: { type: "click"; selector: string };
      idempotencyKey: string;
    };

export type ContentToBackgroundMessage =
  | { kind: "content.domSnapshotResult"; requestId: string; snapshot: RedactedDomSnapshot }
  | { kind: "content.actionResult"; requestId: string; ok: boolean; reason?: string; idempotencyKey?: string };

export type RedactedDomSnapshot = {
  url: string;
  title: string;
  textSample: string;
  interactive: Array<{
    role: string;
    label: string;
    selector: string;
    confidence?: number;
  }>;
  focusGoal?: string;
  sections?: string[];
  profile?: "default" | "sensitive";
  appliedSnapshotPolicy?: SnapshotPolicyConfig;
};
