# Release Checklist

## Build and Quality Gates

- [ ] `npm run lint` passes for all workspaces
- [ ] `npm run typecheck` passes for all workspaces
- [ ] `npm run test` passes for all workspaces
- [ ] `npm run build` succeeds for all workspaces

## Extension Security Gates

- [ ] No wildcard `host_permissions` in production manifest
- [ ] `connect-src` constrained to backend and required Gemini endpoints
- [ ] Browser-internal pages blocked for action execution
- [ ] Restricted domains require explicit user confirmation

## Backend Security Gates

- [ ] `SESSION_CREDENTIAL_SIGNING_SECRET` uses production-grade secret material
- [ ] `SESSION_MINTING_ENABLED` default verified for deployment stage
- [ ] Replay protection active (nonce + timestamp)
- [ ] Per-IP and per-install rate limits validated

## Operational Readiness

- [ ] Emergency disable drill completed (`SESSION_MINTING_ENABLED=false`)
- [ ] Recovery drill completed (reenable + verify end-to-end session start)
- [ ] Secret rotation path documented for on-call
- [ ] Incident communication template available to responders

## Acceptance Verification

- [ ] Session start/stop works from popup
- [ ] Voice input and assistant playback function without stale-buffer artifacts
- [ ] DOM snapshot and action loop behave as expected on representative sites
- [ ] Reconnect/resume behavior validated under forced disconnect
