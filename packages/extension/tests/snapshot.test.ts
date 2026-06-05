import { describe, expect, it } from "vitest";
import {
  buildSnapshotForGoal,
  DEFAULT_SNAPSHOT_POLICY,
  profileForUrl,
  redactTextForSnapshot,
  scoreByGoalTokens,
  selectorConfidence,
  shouldKeepInteractiveCandidate,
  tokenizeGoal
} from "../src/content/snapshot";

describe("goal-aware snapshot helpers", () => {
  it("tokenizes useful goal terms", () => {
    expect(tokenizeGoal("Submit payment form on billing page")).toEqual(["submit", "payment", "form", "billing", "page"]);
  });

  it("redacts sensitive patterns", () => {
    const redacted = redactTextForSnapshot("Contact me at a@b.com or +1 (555) 222-3333 card 4242424242424242");
    expect(redacted.includes("a@b.com")).toBe(false);
    expect(redacted.includes("4242424242424242")).toBe(false);
    expect(redacted.includes("[REDACTED_EMAIL]")).toBe(true);
    expect(redacted.includes("[REDACTED_CARD]")).toBe(true);
    expect(redacted.includes("[REDACTED_PHONE]")).toBe(true);
  });

  it("scores goal-aligned interactive targets higher", () => {
    const goalTokens = tokenizeGoal("submit payment");
    const submitScore = scoreByGoalTokens(goalTokens, "Submit payment", "button", "#submit-payment");
    const neutralScore = scoreByGoalTokens(goalTokens, "Help", "a", "#help-link");
    expect(submitScore).toBeGreaterThan(neutralScore);
  });

  it("uses sensitive profile for high-risk domains", () => {
    expect(profileForUrl("https://billing.example.com/checkout")).toBe("sensitive");
    expect(profileForUrl("https://docs.example.com/guide")).toBe("default");
  });

  it("assigns higher confidence to stable selectors", () => {
    const idConfidence = selectorConfidence("#submit-payment", "Submit");
    const tagConfidence = selectorConfidence("button", "Submit");
    expect(idConfidence).toBeGreaterThan(tagConfidence);
  });

  it("keeps goal-matching candidate even with moderate confidence", () => {
    const keep = shouldKeepInteractiveCandidate({
      goalTokens: tokenizeGoal("submit payment"),
      label: "Submit payment",
      score: 3,
      confidence: 0.4,
      profile: "default",
      policy: DEFAULT_SNAPSHOT_POLICY
    });
    expect(keep).toBe(true);
  });

  it("drops weak non-goal candidates on sensitive profile", () => {
    const keep = shouldKeepInteractiveCandidate({
      goalTokens: tokenizeGoal("submit payment"),
      label: "Read more",
      score: 1,
      confidence: 0.5,
      profile: "sensitive",
      policy: DEFAULT_SNAPSHOT_POLICY
    });
    expect(keep).toBe(false);
  });

  it("includes applied snapshot policy telemetry", () => {
    const documentMock = {
      querySelectorAll: () => [],
      body: { innerText: "" }
    } as unknown as Document;
    const snapshot = buildSnapshotForGoal(documentMock, "https://example.com", "Example", "submit", {
      ...DEFAULT_SNAPSHOT_POLICY,
      policyVersion: "server-v2"
    });
    expect(snapshot.appliedSnapshotPolicy).toEqual({
      minScoreDefault: 4,
      minConfidenceDefault: 0.6,
      minScoreSensitive: 2,
      minConfidenceSensitive: 0.65,
      policyVersion: "server-v2"
    });
  });
});
