const SENSITIVE_HOST_TOKENS = ["bank", "wallet", "admin", "identity", "accounts", "pay", "billing"];
const HIGH_RISK_SELECTOR_TOKENS = ["delete", "submit", "transfer", "confirm", "payment", "withdraw"];

const BLOCKED_PROTOCOLS = new Set(["chrome:", "chrome-extension:", "edge:", "about:", "moz-extension:"]);
const BLOCKED_HOSTS = new Set(["chrome.google.com"]);

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const isBlockedDomain = (url: string): boolean => {
  const parsed = parseUrl(url);
  if (!parsed) return true;
  if (BLOCKED_PROTOCOLS.has(parsed.protocol)) return true;
  if (BLOCKED_HOSTS.has(parsed.hostname)) return true;
  return false;
};

export const isRestrictedDomain = (url: string): boolean => {
  const parsed = parseUrl(url);
  if (!parsed) return true;
  const host = parsed.hostname.toLowerCase();
  return SENSITIVE_HOST_TOKENS.some((token) => host.includes(token));
};

export const isHighRiskSelector = (selector: string): boolean => {
  const normalized = selector.toLowerCase();
  return HIGH_RISK_SELECTOR_TOKENS.some((token) => normalized.includes(token));
};

export const requiresUserConfirmation = (url: string, selector: string): boolean =>
  isRestrictedDomain(url) || isHighRiskSelector(selector);
