import type { RedactedDomSnapshot, SnapshotPolicyConfig } from "../shared/contracts";

const MAX_TEXT_SAMPLE = 5000;
const MAX_INTERACTIVE = 150;
const MAX_SECTIONS = 12;
const SENSITIVE_DOMAIN_TOKENS = ["bank", "wallet", "billing", "payments", "checkout", "account", "identity", "auth"];

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicyConfig = {
  minScoreDefault: 4,
  minConfidenceDefault: 0.6,
  minScoreSensitive: 2,
  minConfidenceSensitive: 0.65,
  policyVersion: "local-default"
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

export const tokenizeGoal = (goal: string): string[] =>
  goal
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);

export const redactTextForSnapshot = (value: string): string =>
  normalizeWhitespace(value)
    .replace(/\b\d{12,19}\b/g, "[REDACTED_CARD]")
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?\d[\d\s\-()]{7,}\d)\b/g, "[REDACTED_PHONE]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]");

export const profileForUrl = (pageUrl: string): "default" | "sensitive" => {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase();
    return SENSITIVE_DOMAIN_TOKENS.some((token) => host.includes(token)) ? "sensitive" : "default";
  } catch {
    return "sensitive";
  }
};

const redactByProfile = (value: string, profile: "default" | "sensitive"): string => {
  const base = redactTextForSnapshot(value);
  if (profile === "default") return base;
  return base
    .replace(/\b\d{6,12}\b/g, "[REDACTED_ACCOUNT]")
    .replace(/\b(?:otp|verification code|one-time code)\s*[:#-]?\s*\d{4,8}\b/gi, "[REDACTED_OTP]");
};

const isSensitiveInput = (element: Element): boolean => {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return false;
  const type = (element as HTMLInputElement).type?.toLowerCase();
  return type === "password" || type === "email" || type === "tel" || element.hasAttribute("data-sensitive");
};

const toSafeSelector = (element: Element): string => {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute("data-testid");
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  return element.tagName.toLowerCase();
};

const getElementLabel = (element: Element): string => {
  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const withValue = element.value?.trim();
    if (withValue) return withValue;
    const placeholder = element.placeholder?.trim();
    if (placeholder) return placeholder;
  }
  return (element.textContent ?? "").trim();
};

export const scoreByGoalTokens = (goalTokens: string[], label: string, role: string, selector: string): number => {
  const normalizedLabel = label.toLowerCase();
  const normalizedRole = role.toLowerCase();
  const normalizedSelector = selector.toLowerCase();
  let score = 0;

  if (normalizedRole.includes("button")) score += 3;
  if (normalizedRole.includes("input") || normalizedRole.includes("textbox")) score += 2;
  if (normalizedRole.includes("a")) score += 1;

  for (const token of goalTokens) {
    if (normalizedLabel.includes(token)) score += 5;
    if (normalizedSelector.includes(token)) score += 2;
  }

  if (normalizedLabel.length > 0 && normalizedLabel.length < 80) score += 1;
  return score;
};

export const selectorConfidence = (selector: string, label: string): number => {
  let confidence = 0.2;
  if (selector.startsWith("#")) confidence += 0.5;
  else if (selector.startsWith("[data-testid=")) confidence += 0.4;
  else if (selector.startsWith("[data-agent-action=")) confidence += 0.4;
  else confidence += 0.15;
  if (label.length >= 3) confidence += 0.1;
  if (label.length > 120) confidence -= 0.1;
  return Math.max(0, Math.min(1, Number(confidence.toFixed(2))));
};

export const shouldKeepInteractiveCandidate = (args: {
  goalTokens: string[];
  label: string;
  score: number;
  confidence: number;
  profile: "default" | "sensitive";
  policy: SnapshotPolicyConfig;
}): boolean => {
  const normalizedLabel = args.label.toLowerCase();
  const goalHit = args.goalTokens.some((token) => normalizedLabel.includes(token));
  const hasUsefulLabel = args.label.length >= 2;

  if (args.profile === "sensitive") {
    return (
      hasUsefulLabel &&
      (goalHit ||
        (args.confidence >= args.policy.minConfidenceSensitive && args.score >= args.policy.minScoreSensitive))
    );
  }
  return (
    hasUsefulLabel &&
    (goalHit || args.score >= args.policy.minScoreDefault || args.confidence >= args.policy.minConfidenceDefault)
  );
};

const buildFocusedTextSample = (rawText: string, goalTokens: string[], profile: "default" | "sensitive"): string => {
  const lines = rawText
    .split(/\n+/g)
    .map((line) => redactByProfile(line, profile))
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";

  const scored = lines.map((line) => {
    const lower = line.toLowerCase();
    const tokenHits = goalTokens.reduce((count, token) => (lower.includes(token) ? count + 1 : count), 0);
    return { line, score: tokenHits * 10 + Math.min(5, Math.floor(line.length / 50)) };
  });

  scored.sort((a, b) => b.score - a.score);
  const merged = scored
    .slice(0, 20)
    .map((item) => item.line)
    .join("\n");
  return merged.slice(0, MAX_TEXT_SAMPLE);
};

export const buildSnapshotForGoal = (
  documentRef: Document,
  pageUrl: string,
  title: string,
  goal: string,
  snapshotPolicy: SnapshotPolicyConfig = DEFAULT_SNAPSHOT_POLICY
): RedactedDomSnapshot => {
  const profile = profileForUrl(pageUrl);
  const goalTokens = tokenizeGoal(goal);
  const candidates = Array.from(documentRef.querySelectorAll("a,button,[role='button'],input,textarea,select"))
    .filter((element) => !isSensitiveInput(element))
    .map((element) => {
      const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
      const label = redactByProfile(getElementLabel(element), profile).slice(0, 140);
      const selector = toSafeSelector(element);
      const confidence = selectorConfidence(selector, label);
      return {
        role,
        label,
        selector,
        confidence,
        score: scoreByGoalTokens(goalTokens, label, role, selector)
      };
    });

  const filteredInteractive = candidates
    .filter((candidate) =>
      shouldKeepInteractiveCandidate({
        goalTokens,
        label: candidate.label,
        score: candidate.score,
        confidence: candidate.confidence,
        profile,
        policy: snapshotPolicy
      })
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_INTERACTIVE)
    .map(({ role, label, selector, confidence }) => ({ role, label, selector, confidence }));

  const interactive =
    filteredInteractive.length > 0
      ? filteredInteractive
      : candidates
          .sort((left, right) => right.score - left.score)
          .slice(0, Math.min(20, MAX_INTERACTIVE))
          .map(({ role, label, selector, confidence }) => ({ role, label, selector, confidence }));

  const sections = Array.from(documentRef.querySelectorAll("h1,h2,h3"))
    .map((heading) => redactByProfile(heading.textContent ?? "", profile))
    .filter((heading) => heading.length > 0)
    .slice(0, MAX_SECTIONS);

  const rawText = documentRef.body?.innerText ?? "";
  const textSample = buildFocusedTextSample(rawText, goalTokens, profile);

  return {
    url: pageUrl,
    title: redactByProfile(title, profile).slice(0, 200),
    textSample,
    interactive,
    focusGoal: goal,
    sections,
    profile,
    appliedSnapshotPolicy: snapshotPolicy
  };
};
