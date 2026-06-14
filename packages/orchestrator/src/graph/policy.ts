import type { AgentAction, BlastRadius, DomSnapshot, Task } from "../types.js";

/**
 * Autonomous guardrail policy. Versioned by `policyVersion` so prompt/parser
 * templates and blocked-domain lists can be rotated with the signed session
 * config. There is no human gate: the Critic enforces this directly.
 */
export interface OrchestratorPolicy {
  policyVersion: string;
  blockedDomains: string[];
  /** Patterns that, if present in an action target/value, force high blast radius. */
  destructivePatterns: RegExp[];
}

export const defaultPolicy = (overrides: Partial<OrchestratorPolicy> = {}): OrchestratorPolicy => ({
  policyVersion: overrides.policyVersion ?? "v1",
  blockedDomains: overrides.blockedDomains ?? ["accounts.google.com", "login.microsoftonline.com", "paypal.com"],
  destructivePatterns: overrides.destructivePatterns ?? [
    /delete/i,
    /remove account/i,
    /transfer/i,
    /wire/i,
    /\bpay\b/i,
    /purchase/i,
    /checkout/i
  ]
});

export const hostnameOf = (url: string | undefined): string => {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export const isBlockedDomain = (policy: OrchestratorPolicy, url: string | undefined): boolean => {
  const host = hostnameOf(url);
  if (!host) return false;
  return policy.blockedDomains.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
};

export const isDestructive = (policy: OrchestratorPolicy, action: AgentAction): boolean => {
  const haystack = `${action.kind} ${action.target ?? ""} ${action.value ?? ""}`;
  return policy.destructivePatterns.some((pattern) => pattern.test(haystack));
};

/** Blast radius from the action kind, reversibility and destructive-pattern match. */
export const classifyBlastRadius = (policy: OrchestratorPolicy, action: AgentAction): BlastRadius => {
  if (action.kind === "submit" || isDestructive(policy, action)) return "high";
  if (action.kind === "fill" || action.kind === "navigate") return "medium";
  return "low";
};

/**
 * Pre-execution feasibility check used by the Critic to cast the Verifier's
 * quorum vote on high blast-radius actions (the post-state verifier runs later).
 */
export const feasibilityPrecheck = (task: Task, snapshot: DomSnapshot | null): boolean => {
  const { action } = task;
  switch (action.kind) {
    case "navigate":
      return Boolean(action.target && /^https?:\/\//.test(action.target));
    case "click":
    case "fill":
    case "submit":
      if (!action.target) return false;
      if (!snapshot) return true;
      return snapshot.elements.some((element) => element.selector === action.target);
    default:
      return true;
  }
};
