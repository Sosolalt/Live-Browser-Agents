# Operations Runbook

## Scope

This runbook covers emergency controls and triage for the backend endpoints:
- `POST /api/install/register`
- `POST /api/session-init`

The immediate control plane is environment-driven and can be applied without code changes.

## Emergency Disable: Session Minting

### When to use
- Ongoing abuse spike or credential stuffing against `session-init`
- Unexpected token issuance behavior
- Backend dependency outage where issuing credentials would fail downstream

### Procedure
1. Set `SESSION_MINTING_ENABLED=false` on the backend deployment.
2. Set `SESSION_MINTING_DISABLE_REASON` to an operator-friendly message.
3. Restart or roll the service.
4. Verify:
   - `GET /health` returns `200`.
   - `POST /api/session-init` returns `503` with `error.code = "service_disabled"`.

### Rollback
1. Set `SESSION_MINTING_ENABLED=true`.
2. Clear `SESSION_MINTING_DISABLE_REASON` (optional).
3. Restart or roll the service.
4. Verify successful end-to-end session initialization from extension.

## Rotation Guidance

### Session credential signing secret
- Rotate `SESSION_CREDENTIAL_SIGNING_SECRET` via secret manager.
- Deploy with both old and new rollout windows coordinated (if dual validation is added later).
- Confirm newly issued credentials are accepted and old credentials expire naturally.

### Install key re-registration
- If install key compromise is suspected, require affected clients to re-register keys through `/api/install/register`.
- Track install IDs impacted and maintain incident timeline.

## Triage Checklist

1. Identify symptom class:
   - auth failures (`invalid_auth`, `unknown_install`)
   - replay detections (`replay_detected`)
   - abuse throttling (`rate_limited`)
   - infra readiness (`not_ready`, `service_disabled`)
2. Validate blast radius:
   - single install
   - single IP block
   - multi-region/systemic
3. Apply immediate mitigation:
   - temporary disable switch
   - tighter rate limits
   - key rotation or install re-registration
4. Preserve evidence:
   - exact timestamps
   - affected install IDs
   - request volume and error-code distribution

## Post-Incident Actions

- Write incident summary with root cause and timeline.
- Add or update test coverage for the failure mode.
- Update `POLICY_VERSION` and guardrails if policy gaps were involved.
