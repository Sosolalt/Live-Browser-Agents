import { z } from "zod";

export type AppConfig = {
  port: number;
  sessionCredentialSigningSecret: string;
  sessionMintingEnabled: boolean;
  sessionMintingDisableReason?: string;
  requestMaxAgeMs: number;
  nonceTtlMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxPerIp: number;
  rateLimitMaxPerInstallId: number;
  geminiModel: string;
  geminiVoice: string;
  geminiLiveWebSocketUrl: string;
  policyVersion: string;
  guardrails: string[];
};

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  SESSION_CREDENTIAL_SIGNING_SECRET: z.string().min(32),
  SESSION_MINTING_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  SESSION_MINTING_DISABLE_REASON: z.string().optional(),
  REQUEST_MAX_AGE_MS: z.coerce.number().int().positive().default(60_000),
  NONCE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_PER_IP: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MAX_PER_INSTALL_ID: z.coerce.number().int().positive().default(10),
  GEMINI_LIVE_MODEL: z.string().min(1).default("models/gemini-2.5-flash-preview-native-audio-dialog"),
  GEMINI_LIVE_VOICE: z.string().min(1).default("Aoede"),
  GEMINI_LIVE_WS_URL: z.string().default(""),
  POLICY_VERSION: z.string().min(1).default("v1"),
  GUARDRAILS: z.string().default("safe-default")
});

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsedEnv = envSchema.safeParse(env);
  if (!parsedEnv.success) {
    throw new Error(`Invalid environment configuration: ${parsedEnv.error.message}`);
  }

  const values = parsedEnv.data;

  return {
    port: values.PORT,
    sessionCredentialSigningSecret: values.SESSION_CREDENTIAL_SIGNING_SECRET,
    sessionMintingEnabled: values.SESSION_MINTING_ENABLED,
    sessionMintingDisableReason: values.SESSION_MINTING_DISABLE_REASON,
    requestMaxAgeMs: values.REQUEST_MAX_AGE_MS,
    nonceTtlMs: values.NONCE_TTL_MS,
    rateLimitWindowMs: values.RATE_LIMIT_WINDOW_MS,
    rateLimitMaxPerIp: values.RATE_LIMIT_MAX_PER_IP,
    rateLimitMaxPerInstallId: values.RATE_LIMIT_MAX_PER_INSTALL_ID,
    geminiModel: values.GEMINI_LIVE_MODEL,
    geminiVoice: values.GEMINI_LIVE_VOICE,
    geminiLiveWebSocketUrl: values.GEMINI_LIVE_WS_URL,
    policyVersion: values.POLICY_VERSION,
    guardrails: values.GUARDRAILS.split(",").map((item) => item.trim()).filter(Boolean)
  };
};
