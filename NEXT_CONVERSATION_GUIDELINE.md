# Next Conversation Guideline

Use this as the startup context in the next chat so progress remains continuous.

## 1) Source of Truth to Read First

1. `new-version/CURRENT_STATE.md`
2. `new-version/HANDOFF_SUMMARY.md`
3. `/Users/lucas/.cursor/plans/gemini_live_extension_rewrite_4f2d27cf.plan.md`

## 2) Working Rules

- Keep all implementation inside `new-version`.
- Preserve MV3 safety posture and least-privilege principles.
- Do not weaken replay/rate-limit/auth controls.
- Keep redaction strict by default.
- Always run after substantial edits:
  - `npm run test`
  - `npm run lint`
  - `npm run typecheck`

## 3) Immediate Priorities

1. Add runtime quality counters/alerts for snapshot degradation signals:
   - high low-confidence ratio
   - empty/pruned interactive fallback frequency
2. Add backend observability hooks for snapshot telemetry trends.
3. Add higher-fidelity adversarial and E2E coverage from milestone plan.

## 4) Definition of a Good Next Slice

- Delivers one concrete hardening improvement end-to-end.
- Includes tests for new behavior and regressions.
- Keeps all workspace checks green.
- Updates `CURRENT_STATE.md` if architecture or behavior changed.

## 5) Suggested Prompt for Next Chat

"Continue from `new-version/CURRENT_STATE.md` and the plan file. Implement the next highest-impact hardening slice end-to-end, include tests, and run full test/lint/typecheck before finishing."
