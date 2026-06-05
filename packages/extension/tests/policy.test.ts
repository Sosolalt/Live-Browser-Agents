import { describe, expect, it } from "vitest";
import { isBlockedDomain, isHighRiskSelector, isRestrictedDomain, requiresUserConfirmation } from "../src/background/policy";

describe("background action policy", () => {
  it("blocks browser-internal and extension pages", () => {
    expect(isBlockedDomain("chrome://settings")).toBe(true);
    expect(isBlockedDomain("chrome-extension://abcdef/index.html")).toBe(true);
    expect(isBlockedDomain("https://example.com")).toBe(false);
  });

  it("detects restricted domains and high-risk selectors", () => {
    expect(isRestrictedDomain("https://bank.example.com/")).toBe(true);
    expect(isRestrictedDomain("https://docs.example.com/")).toBe(false);
    expect(isHighRiskSelector("#confirm-transfer")).toBe(true);
    expect(isHighRiskSelector("#search-button")).toBe(false);
  });

  it("requires confirmation on restricted domain or risky selector", () => {
    expect(requiresUserConfirmation("https://wallet.example.com", "#safe-action")).toBe(true);
    expect(requiresUserConfirmation("https://example.com", "#submit-payment")).toBe(true);
    expect(requiresUserConfirmation("https://example.com", "#safe-action")).toBe(false);
  });
});
