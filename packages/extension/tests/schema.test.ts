import { describe, expect, it } from "vitest";
import { isBackgroundToContentMessage, isContentToBackgroundMessage, isPopupToBackgroundMessage } from "../src/shared/schema";

describe("popup message schema", () => {
  it("accepts valid execute action message", () => {
    expect(
      isPopupToBackgroundMessage({
        kind: "popup.executeAction",
        action: { type: "click", selector: "#submit" },
        idempotencyKey: "abc-123",
        userConfirmed: true
      })
    ).toBe(true);
  });

  it("rejects execute action without idempotency key", () => {
    expect(
      isPopupToBackgroundMessage({
        kind: "popup.executeAction",
        action: { type: "click", selector: "#submit" },
        userConfirmed: false
      })
    ).toBe(false);
  });
});

describe("background to content schema", () => {
  it("accepts execute action with idempotency key", () => {
    expect(
      isBackgroundToContentMessage({
        kind: "background.executeAction",
        requestId: "req-1",
        action: { type: "click", selector: "#safe" },
        idempotencyKey: "idem-1"
      })
    ).toBe(true);
  });

  it("accepts dom snapshot request with snapshot policy", () => {
    expect(
      isBackgroundToContentMessage({
        kind: "background.requestDomSnapshot",
        requestId: "req-2",
        goal: "submit payment",
        snapshotPolicy: {
          minScoreDefault: 4,
          minConfidenceDefault: 0.6,
          minScoreSensitive: 2,
          minConfidenceSensitive: 0.65,
          policyVersion: "v1"
        }
      })
    ).toBe(true);
  });

  it("rejects dom snapshot request with invalid snapshot policy shape", () => {
    expect(
      isBackgroundToContentMessage({
        kind: "background.requestDomSnapshot",
        requestId: "req-3",
        goal: "submit payment",
        snapshotPolicy: {
          minScoreDefault: 4
        }
      })
    ).toBe(false);
  });
});

describe("content to background schema", () => {
  it("rejects dom snapshot result without snapshot object", () => {
    expect(
      isContentToBackgroundMessage({
        kind: "content.domSnapshotResult",
        requestId: "req-1"
      })
    ).toBe(false);
  });

  it("rejects action result without boolean ok", () => {
    expect(
      isContentToBackgroundMessage({
        kind: "content.actionResult",
        requestId: "req-1",
        ok: "true"
      })
    ).toBe(false);
  });
});
