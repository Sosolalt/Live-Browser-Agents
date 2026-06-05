import type { BackgroundToContentMessage } from "../shared/contracts";
import { isBackgroundToContentMessage } from "../shared/schema";
import { buildSnapshotForGoal } from "./snapshot";

const isActionAllowed = (message: BackgroundToContentMessage): boolean => {
  if (message.kind !== "background.executeAction") return true;
  if (message.action.type !== "click") return false;
  const selector = message.action.selector.trim();
  return selector.startsWith("[data-agent-action=") || selector.startsWith("[data-testid=") || selector.startsWith("#");
};

const executeAction = (message: BackgroundToContentMessage): { ok: boolean; reason?: string } => {
  if (message.kind !== "background.executeAction") return { ok: false, reason: "invalid_action_kind" };
  const target = document.querySelector(message.action.selector);
  if (!(target instanceof HTMLElement)) return { ok: false, reason: "target_not_found" };
  target.click();
  return { ok: true };
};

const cancelledIdempotencyKeys = new Set<string>();

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isBackgroundToContentMessage(message)) return false;

  if (!isActionAllowed(message)) {
    void chrome.runtime.sendMessage({
      kind: "content.actionResult",
      requestId: message.requestId,
      ok: false,
      reason: "policy_blocked"
    });
    sendResponse({ ok: false, reason: "policy_blocked" });
    return false;
  }

  if (message.kind === "background.requestDomSnapshot") {
    const snapshot = buildSnapshotForGoal(document, location.href, document.title, message.goal, message.snapshotPolicy);
    void chrome.runtime.sendMessage({ kind: "content.domSnapshotResult", requestId: message.requestId, snapshot });
    sendResponse({ ok: true });
    return false;
  }

  if (message.kind === "background.cancelAction") {
    cancelledIdempotencyKeys.add(message.idempotencyKey);
    sendResponse({ ok: true, cancelled: true });
    return false;
  }

  if (cancelledIdempotencyKeys.has(message.idempotencyKey)) {
    void chrome.runtime.sendMessage({
      kind: "content.actionResult",
      requestId: message.requestId,
      ok: false,
      reason: "cancelled",
      idempotencyKey: message.idempotencyKey
    });
    sendResponse({ ok: false, reason: "cancelled" });
    return false;
  }

  const result = executeAction(message);
  void chrome.runtime.sendMessage({
    kind: "content.actionResult",
    requestId: message.requestId,
    ok: result.ok,
    reason: result.reason,
    idempotencyKey: message.idempotencyKey
  });
  sendResponse(result);
  return false;
});
