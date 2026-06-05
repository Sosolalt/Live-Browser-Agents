import crypto from "node:crypto";

export type AuditLogger = {
  info: (event: string, payload: Record<string, unknown>) => void;
  warn: (event: string, payload: Record<string, unknown>) => void;
};

const hashValue = (value: string): string => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

export const toHashedField = (value: string | undefined): string | undefined => {
  if (!value || value.length === 0) return undefined;
  return hashValue(value);
};

export const createConsoleAuditLogger = (): AuditLogger => ({
  info(event, payload) {
    console.info(JSON.stringify({ level: "info", event, ...payload }));
  },
  warn(event, payload) {
    console.warn(JSON.stringify({ level: "warn", event, ...payload }));
  }
});
