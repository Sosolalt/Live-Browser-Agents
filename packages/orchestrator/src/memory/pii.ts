import crypto from "node:crypto";

// PII classifier gate. Runs before every write so credentials, payment fields and
// government IDs never land in plaintext `properties`. Detection is both
// field-name- and value-pattern-based so a generic field name cannot smuggle a
// card number through.

export type PiiAction = "keep" | "redact" | "hash" | "seal";

export interface PiiResult {
  /** Safe payload to store in JSONB properties (redaction/hash markers applied). */
  safeProperties: Record<string, unknown>;
  /** field -> plaintext to AEAD-seal (recoverable only via authenticated export). */
  sealable: Record<string, string>;
  /** Categories detected, for audit. */
  categories: string[];
  /** Raw plaintext values that were sealed/hashed/redacted — used to scrub labels. */
  sensitiveValues: string[];
}

const SECRET_FIELD = /(pass(word|code)?|secret|token|api[-_]?key|otp|cvv|cvc|pin|private[-_]?key)/i;
const FINANCIAL_FIELD = /(card|credit|iban|account[-_]?number|routing|ssn|social|passport|license|tax[-_]?id|gov)/i;
const CONTACT_FIELD = /(email|e-mail|phone|mobile|tel)/i;

const CARD_VALUE = /\b(?:\d[ -]?){13,19}\b/;
const SSN_VALUE = /\b\d{3}-\d{2}-\d{4}\b/;
const EMAIL_VALUE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

// Patterns scrubbed when they appear *embedded* in otherwise-kept free text.
const EMBEDDED_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const EMBEDDED_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMBEDDED_CARD = /\b(?:\d[ -]?){13,19}\b/g;

const scrubText = (text: string): { scrubbed: string; found: string[] } => {
  const found: string[] = [];
  let scrubbed = text;
  scrubbed = scrubbed.replace(EMBEDDED_EMAIL, (match) => {
    found.push(match);
    return "[redacted-email]";
  });
  scrubbed = scrubbed.replace(EMBEDDED_SSN, (match) => {
    found.push(match);
    return "[redacted-id]";
  });
  scrubbed = scrubbed.replace(EMBEDDED_CARD, (match) => {
    found.push(match);
    return "[redacted-number]";
  });
  return { scrubbed, found };
};

const hash = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

const classify = (field: string, value: unknown): PiiAction => {
  if (SECRET_FIELD.test(field)) return "redact";
  if (FINANCIAL_FIELD.test(field)) return "seal";
  const str = typeof value === "string" ? value : "";
  if (str.length > 0) {
    if (SSN_VALUE.test(str) || CARD_VALUE.test(str.replace(/[^\d -]/g, ""))) return "seal";
    if (CONTACT_FIELD.test(field) || EMAIL_VALUE.test(str)) return "hash";
  }
  if (CONTACT_FIELD.test(field)) return "hash";
  return "keep";
};

export class PiiGate {
  scan(properties: Record<string, unknown>): PiiResult {
    const safeProperties: Record<string, unknown> = {};
    const sealable: Record<string, string> = {};
    const categories = new Set<string>();
    const sensitiveValues: string[] = [];

    for (const [field, value] of Object.entries(properties)) {
      const action = classify(field, value);
      switch (action) {
        case "redact":
          safeProperties[field] = "[redacted]";
          categories.add("credential");
          sensitiveValues.push(stringify(value));
          break;
        case "seal":
          sealable[field] = stringify(value);
          safeProperties[field] = "[sealed]";
          categories.add("financial_or_gov_id");
          sensitiveValues.push(stringify(value));
          break;
        case "hash":
          safeProperties[`${field}_hash`] = hash(stringify(value));
          categories.add("contact");
          sensitiveValues.push(stringify(value));
          break;
        case "keep":
        default: {
          // Scrub PII embedded in otherwise-safe free text (emails, cards, IDs).
          if (typeof value === "string") {
            const { scrubbed, found } = scrubText(value);
            safeProperties[field] = scrubbed;
            if (found.length > 0) {
              categories.add("embedded_pii");
              sensitiveValues.push(...found);
            }
          } else {
            safeProperties[field] = value;
          }
          break;
        }
      }
    }

    return { safeProperties, sealable, categories: [...categories], sensitiveValues: sensitiveValues.filter(Boolean) };
  }
}

const stringify = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
