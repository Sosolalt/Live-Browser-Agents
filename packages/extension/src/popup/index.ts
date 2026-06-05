import type {
  BackgroundToPopupMessage,
  PopupToBackgroundMessage,
  RuntimeState
} from "../shared/contracts";
import { decodePcm16Base64ToFloat32 } from "../shared/audioCodec";

const stateNode = document.querySelector<HTMLDivElement>("#connectionState");
const statusNode = document.querySelector<HTMLPreElement>("#statusOutput");
const transcriptNode = document.querySelector<HTMLTextAreaElement>("#transcriptInput");
const micNode = document.querySelector<HTMLInputElement>("#micToggle");
const startButton = document.querySelector<HTMLButtonElement>("#startButton");
const stopButton = document.querySelector<HTMLButtonElement>("#stopButton");
const sendButton = document.querySelector<HTMLButtonElement>("#sendButton");
const snapshotButton = document.querySelector<HTMLButtonElement>("#snapshotButton");
const clickButton = document.querySelector<HTMLButtonElement>("#clickButton");
const cancelActionButton = document.querySelector<HTMLButtonElement>("#cancelActionButton");
const actionSelectorInput = document.querySelector<HTMLInputElement>("#actionSelectorInput");
let lastActionIdempotencyKey: string | null = null;

let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let processorNode: ScriptProcessorNode | null = null;
let playbackContext: AudioContext | null = null;
let playbackTailTime = 0;
const activePlaybackNodes = new Set<AudioBufferSourceNode>();

const ensurePlaybackContext = (): AudioContext => {
  if (!playbackContext || playbackContext.state === "closed") {
    playbackContext = new AudioContext({ sampleRate: 16000 });
  }
  return playbackContext;
};

const flushPlayback = (): void => {
  for (const node of activePlaybackNodes) {
    try {
      node.stop();
    } catch {
      // Ignore already-stopped nodes.
    }
    node.disconnect();
  }
  activePlaybackNodes.clear();
  const context = playbackContext;
  if (context) {
    playbackTailTime = context.currentTime;
  } else {
    playbackTailTime = 0;
  }
};

const enqueueAssistantAudio = (sampleRate: number, pcmBase64: string): void => {
  const context = ensurePlaybackContext();
  const samples = decodePcm16Base64ToFloat32(pcmBase64);
  if (samples.length === 0) {
    return;
  }
  const buffer = context.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);

  const now = context.currentTime;
  const startAt = Math.max(now, playbackTailTime);
  source.start(startAt);
  playbackTailTime = startAt + buffer.duration;
  activePlaybackNodes.add(source);
  source.onended = () => {
    activePlaybackNodes.delete(source);
  };
};

const stopMicCapture = (): void => {
  processorNode?.disconnect();
  sourceNode?.disconnect();
  processorNode = null;
  sourceNode = null;
  if (audioContext) {
    void audioContext.close();
  }
  audioContext = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
};

const startMicCapture = async (): Promise<void> => {
  if (mediaStream) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(2048, 1, 1);
    processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const frame = event.inputBuffer.getChannelData(0);
      void sendPopupMessage({
        kind: "popup.micChunk",
        sampleRate: event.inputBuffer.sampleRate,
        samples: Array.from(frame)
      });
    };
    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);
  } catch (error) {
    stopMicCapture();
    if (statusNode) {
      statusNode.textContent = `error: ${error instanceof Error ? error.message : "mic_capture_failed"}`;
    }
    if (micNode) {
      micNode.checked = false;
    }
    void sendPopupMessage({ kind: "popup.setMicActive", micActive: false });
  }
};

const render = (state: RuntimeState): void => {
  if (!stateNode || !statusNode || !micNode || !transcriptNode) return;
  stateNode.textContent = `state: ${state.connectionState}`;
  micNode.checked = state.micActive;
  transcriptNode.value = state.transcript;
  statusNode.textContent = JSON.stringify(state, null, 2);
};

const requestRuntimeState = async (): Promise<void> => {
  const response = (await chrome.runtime.sendMessage({ kind: "popup.getRuntimeState" })) as {
    ok: boolean;
    state?: RuntimeState;
  };
  if (response?.state) render(response.state);
};

const sendPopupMessage = async (message: PopupToBackgroundMessage): Promise<void> => {
  const response = (await chrome.runtime.sendMessage(message)) as {
    ok: boolean;
    state?: RuntimeState;
  };
  if (response?.state) render(response.state);
};

startButton?.addEventListener("click", () => {
  void sendPopupMessage({ kind: "popup.startSession" });
});

stopButton?.addEventListener("click", () => {
  void sendPopupMessage({ kind: "popup.stopSession" });
});

micNode?.addEventListener("change", () => {
  const micActive = Boolean(micNode?.checked);
  void sendPopupMessage({ kind: "popup.setMicActive", micActive });
  if (micActive) {
    flushPlayback();
    void sendPopupMessage({ kind: "popup.bargeIn" });
    void startMicCapture();
  } else {
    stopMicCapture();
  }
});

sendButton?.addEventListener("click", () => {
  void sendPopupMessage({ kind: "popup.sendTranscript", text: transcriptNode?.value ?? "" });
});

snapshotButton?.addEventListener("click", () => {
  void sendPopupMessage({ kind: "popup.requestDomSnapshot", goal: "Summarize actionable elements on current page." });
});

clickButton?.addEventListener("click", () => {
  const selector = actionSelectorInput?.value?.trim() ?? "";
  if (!selector) {
    if (statusNode) statusNode.textContent = "error: selector required";
    return;
  }
  void sendPopupMessage({
    kind: "popup.executeAction",
    action: { type: "click", selector },
    idempotencyKey: (lastActionIdempotencyKey = crypto.randomUUID()),
    userConfirmed: window.confirm(`Execute click action on selector "${selector}"?`)
  });
});

cancelActionButton?.addEventListener("click", () => {
  if (!lastActionIdempotencyKey) {
    if (statusNode) statusNode.textContent = "error: no action to cancel";
    return;
  }
  void sendPopupMessage({
    kind: "popup.cancelAction",
    idempotencyKey: lastActionIdempotencyKey
  });
});

chrome.runtime.onMessage.addListener((message: BackgroundToPopupMessage) => {
  if (message.kind === "background.runtimeState") render(message.state);
  if (message.kind === "background.error" && statusNode) statusNode.textContent = `error: ${message.message}`;
  if (message.kind === "background.assistantAudioChunk") {
    enqueueAssistantAudio(message.sampleRate, message.pcmBase64);
  }
  if (message.kind === "background.playbackInterrupted") {
    flushPlayback();
  }
});

void requestRuntimeState();

window.addEventListener("beforeunload", () => {
  flushPlayback();
  stopMicCapture();
  if (playbackContext) {
    void playbackContext.close();
    playbackContext = null;
  }
});
