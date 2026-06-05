import type { SessionInitResult } from "./session";

const REGISTER_ENDPOINT = "https://token-service.example.com/api/install/register";
const TOKEN_ENDPOINT = "https://token-service.example.com/api/session-init";

const encodeBase64 = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)));

const buildCanonicalPayload = (installId: string, timestamp: number, nonce: string): string =>
  `${installId}\n${timestamp}\n${nonce}`;

const createNonce = (): string => crypto.randomUUID().replace(/-/g, "");
const KEYPAIR_KEY = "runtime.installKeypair";

const getOrCreateInstallId = async (): Promise<string> => {
  const key = "runtime.installId";
  const stored = await chrome.storage.local.get(key);
  if (typeof stored[key] === "string" && stored[key].length > 0) {
    return stored[key] as string;
  }
  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ [key]: installId });
  return installId;
};

const getOrCreateInstallKeypair = async (): Promise<{ privateKey: CryptoKey; publicKeyJwk: JsonWebKey }> => {
  const stored = await chrome.storage.local.get(KEYPAIR_KEY);
  const cached = stored[KEYPAIR_KEY] as { privateKeyJwk?: JsonWebKey; publicKeyJwk?: JsonWebKey } | undefined;
  if (cached?.privateKeyJwk && cached.publicKeyJwk) {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      cached.privateKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );
    return { privateKey, publicKeyJwk: cached.publicKeyJwk };
  }
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  await chrome.storage.local.set({ [KEYPAIR_KEY]: { privateKeyJwk, publicKeyJwk } });
  return { privateKey: keyPair.privateKey, publicKeyJwk };
};

const registerInstall = async (installId: string, publicKeyJwk: JsonWebKey): Promise<void> => {
  const response = await fetch(REGISTER_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ installId, publicKeyJwk })
  });
  if (!response.ok) {
    throw new Error(`install_register_failed_${response.status}`);
  }
};

const signRequest = async (payload: string, privateKey: CryptoKey): Promise<string> => {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return encodeBase64(signature);
};

export const fetchSessionInitToken = async (): Promise<SessionInitResult> => {
  const installId = await getOrCreateInstallId();
  const keypair = await getOrCreateInstallKeypair();
  await registerInstall(installId, keypair.publicKeyJwk);
  const timestamp = Date.now();
  const nonce = createNonce();
  const payload = buildCanonicalPayload(installId, timestamp, nonce);
  const signature = await signRequest(payload, keypair.privateKey);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ installId, timestamp, nonce, signature })
  });
  if (!response.ok) {
    throw new Error(`session_init_failed_${response.status}`);
  }
  const data = (await response.json()) as {
    session?: { accessToken?: string };
    startupConfig?: {
      model?: string;
      voice?: string;
      policyVersion?: string;
      guardrails?: string[];
      liveWebSocketUrl?: string;
      snapshotPolicy?: {
        minScoreDefault?: number;
        minConfidenceDefault?: number;
        minScoreSensitive?: number;
        minConfidenceSensitive?: number;
        policyVersion?: string;
      };
    };
  };
  const token = data.session?.accessToken;
  if (!token) {
    throw new Error("session_init_missing_access_token");
  }
  const startupConfig = data.startupConfig;
  if (!startupConfig?.model || !startupConfig.voice || !startupConfig.policyVersion) {
    throw new Error("session_init_missing_startup_config");
  }
  return {
    accessToken: token,
    startupConfig: {
      model: startupConfig.model,
      voice: startupConfig.voice,
      policyVersion: startupConfig.policyVersion,
      guardrails: Array.isArray(startupConfig.guardrails) ? startupConfig.guardrails : [],
      liveWebSocketUrl: startupConfig.liveWebSocketUrl,
      snapshotPolicy:
        typeof startupConfig.snapshotPolicy?.minScoreDefault === "number" &&
        typeof startupConfig.snapshotPolicy?.minConfidenceDefault === "number" &&
        typeof startupConfig.snapshotPolicy?.minScoreSensitive === "number" &&
        typeof startupConfig.snapshotPolicy?.minConfidenceSensitive === "number"
          ? {
              minScoreDefault: startupConfig.snapshotPolicy.minScoreDefault,
              minConfidenceDefault: startupConfig.snapshotPolicy.minConfidenceDefault,
              minScoreSensitive: startupConfig.snapshotPolicy.minScoreSensitive,
              minConfidenceSensitive: startupConfig.snapshotPolicy.minConfidenceSensitive,
              policyVersion:
                typeof startupConfig.snapshotPolicy.policyVersion === "string"
                  ? startupConfig.snapshotPolicy.policyVersion
                  : undefined
            }
          : undefined
    }
  };
};
