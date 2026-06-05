export type SessionInitResult = {
  accessToken: string;
  startupConfig: {
    model: string;
    voice: string;
    policyVersion: string;
    guardrails: string[];
    liveWebSocketUrl?: string;
    snapshotPolicy?: {
      minScoreDefault: number;
      minConfidenceDefault: number;
      minScoreSensitive: number;
      minConfidenceSensitive: number;
      policyVersion?: string;
    };
  };
};
