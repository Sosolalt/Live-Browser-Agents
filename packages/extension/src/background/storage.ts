import type { OutboundEvent, ResumptionHandle } from "../shared/contracts";

const RESUMPTION_KEY = "runtime.resumptionHandle";
const REPLAY_BUFFER_KEY = "runtime.replayBuffer";
const REPLAY_BUFFER_LIMIT = 100;

export const loadResumptionHandle = async (): Promise<ResumptionHandle | null> => {
  const result = await chrome.storage.local.get(RESUMPTION_KEY);
  const value = result[RESUMPTION_KEY];
  if (!value || typeof value !== "object") return null;
  return value as ResumptionHandle;
};

export const persistResumptionHandle = async (handle: ResumptionHandle | null): Promise<void> => {
  if (!handle) {
    await chrome.storage.local.remove(RESUMPTION_KEY);
    return;
  }
  await chrome.storage.local.set({ [RESUMPTION_KEY]: handle });
};

export const enqueueReplayEvent = async (event: OutboundEvent): Promise<void> => {
  const result = await chrome.storage.local.get(REPLAY_BUFFER_KEY);
  const existing = Array.isArray(result[REPLAY_BUFFER_KEY]) ? (result[REPLAY_BUFFER_KEY] as OutboundEvent[]) : [];
  const next = [...existing, event].slice(-REPLAY_BUFFER_LIMIT);
  await chrome.storage.local.set({ [REPLAY_BUFFER_KEY]: next });
};

export const loadReplayBuffer = async (): Promise<OutboundEvent[]> => {
  const result = await chrome.storage.local.get(REPLAY_BUFFER_KEY);
  const value = result[REPLAY_BUFFER_KEY];
  return Array.isArray(value) ? (value as OutboundEvent[]) : [];
};

export const clearReplayBuffer = async (): Promise<void> => {
  await chrome.storage.local.remove(REPLAY_BUFFER_KEY);
};
