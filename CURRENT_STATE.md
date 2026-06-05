# Gemini Live Extension Rewrite - Current State

## Repository Scope

- Active implementation root: `new-version`
- Monorepo packages:
  - `packages/extension` (Manifest V3 extension, TypeScript)
  - `packages/backend` (TypeScript backend for session-init/install-register)
- Source of truth plan:
  - `/Users/lucas/.cursor/plans/gemini_live_extension_rewrite_4f2d27cf.plan.md`

## Delivery Status by Phase (1-6 Core Plan)

### Phase 1 - Product Foundation and Build Integrity

**Progress:** ~85% (mostly complete, hardening remaining)

**Implemented**
- TypeScript MV3 extension and backend are scaffolded and active.
- Workspace quality gates are operational:
  - `npm run test`
  - `npm run lint`
  - `npm run typecheck`
- Baseline manifest/CSP and package structure are in place for extension runtime and backend APIs.

**Remaining blockers / gaps**
- Ensure production manifest/connect policy validation is automated in CI (explicit no-wildcard checks for all release variants).
- Confirm environment-specific config generation is fully deterministic across local/dev/prod.
- Add explicit release artifact integrity checks and documented reproducibility workflow.

---

### Phase 2 - Authenticated Session and Install Identity Security

**Progress:** ~75% (core controls present, distributed and enrollment hardening pending)

**Implemented**
- `POST /api/session-init` includes:
  - install signature verification (ECDSA)
  - nonce replay protection
  - timestamp freshness checks
  - per-IP and per-install rate limits
  - emergency minting kill switch
- Session-init startup config returns:
  - model, voice, guardrails, policyVersion
  - websocket URL
  - server-driven snapshot policy thresholds
- Structured audit logging:
  - hashed identity fields
  - explicit reject reasons
  - no raw signature/token logging
- Registration overwrite protection now enforced:
  - existing `installId` cannot be silently overwritten.

**Remaining blockers / gaps**
- Add authenticated enrollment requirement for `/api/install/register` (trusted principal or enrollment token).
- Add explicit signed key-rotation flow (proof-of-possession of previous key).
- Move nonce/rate-limit/install identity state from process memory to shared durable store for multi-instance correctness.

---

### Phase 3 - Runtime Orchestration and Reliable Transport

**Progress:** ~80% (strong baseline, protocol and failure-mode refinements pending)

**Implemented**
- Background orchestrator lifecycle and reconnect logic are implemented.
- Replay buffering and reconnect recovery are implemented.
- Message spoofing hardening added:
  - sender checks for content channel
  - sender checks for popup/runtime channel
  - stricter schema validation
- Action dispatch pipeline includes:
  - idempotency controls
  - cancellation controls
  - deterministic bounded dispatch queue
  - blocked-domain and confirmation checks
- Manual stop/reconnect race fixed:
  - explicit stop no longer causes unintended reconnect scheduling.

**Remaining blockers / gaps**
- Promote state machine into explicit transition-table/reducer model with legal transition assertions.
- Remove or strictly gate non-production transport fallbacks to avoid silent degraded behavior.
- Implement ack-based replay guarantees if exactly-once delivery semantics are required.

---

### Phase 4 - Conversational Voice Experience and Latency Controls

**Progress:** ~70% (pipeline works, product polish and latency SLO instrumentation pending)

**Implemented**
- Popup mic capture -> background chunk flow is working.
- Background normalization/encoding path is implemented.
- Assistant audio chunk relay and interruption handling are implemented.
- Backpressure drop behavior implemented and covered by tests.

**Remaining blockers / gaps**
- Add explicit per-session latency and audio quality counters with user-visible degraded-state warnings.
- Expand voice stability validation with longer soak/perf runs.
- Implement compact/floating UX mode if included in release scope.

---

### Phase 5 - Action Intelligence Loop (Plan -> Act -> Verify)

**Progress:** ~72% (safety controls present, full model-driven verify loop still incomplete)

**Implemented**
- DOM snapshot quality and safety:
  - goal-aware parsing
  - sensitive-domain profile support
  - redaction for common sensitive patterns
  - confidence scoring/ranking with pruning and fallback subset
- Server-driven snapshot policy now passed end-to-end:
  - backend -> token fetch -> orchestrator -> content snapshot builder
- Snapshot telemetry attached to outbound events:
  - interactive count
  - average confidence
  - low-confidence count
  - profile
  - policy version
- Action safety controls:
  - domain blocking
  - user confirmation for risky actions
  - cancellation + idempotency + queue bounds

**Remaining blockers / gaps**
- Complete model/tool-call-driven action loop end-to-end (not only UI-triggered flows).
- Implement explicit verify-after-action protocol to prevent repeated incorrect action loops.
- Tighten selector/action capability model further for prompt-injection-resistant execution.

---

### Phase 6 - Safety, Privacy, Resilience, and Product Quality

**Progress:** ~60% (core primitives exist, release-grade E2E/adversarial/ops evidence incomplete)

**Implemented**
- Security/privacy primitives in place:
  - structured redacted logging
  - schema validation
  - sender trust checks
  - replay and abuse controls at API layer
- Unit/integration coverage is broad across backend and extension.

**Remaining blockers / gaps**
- Build realistic Chrome E2E coverage for popup/background/content integration.
- Expand adversarial fidelity:
  - prompt injection
  - spoofing and race stress at higher realism
  - multi-instance replay/rate-limit conformance
- Add backend aggregation/observability for snapshot telemetry trends and runtime degradation signals.
- Complete release gate evidence pack (security, reliability, performance, privacy).

## Milestone/Gate Snapshot

- **Milestones 1-3:** Substantially implemented with targeted hardening pending.
- **Milestones 4-6:** Functional baseline exists; quality, telemetry, and release-gate evidence remain the primary risk.
- **Milestone 7 (release candidate gate):** Not yet reached.
- **Milestone 8 (optional future expansion):** Not started by design.

## Current Test and Quality Status

- Workspace checks currently passing:
  - `npm run test`
  - `npm run lint`
  - `npm run typecheck`
- Current extension tests cover:
  - schema, policy, snapshot, transport, adversarial, orchestrator, audio/audioCodec
- Current backend tests cover:
  - session-init, security-conformance

### Phase 7 - Autonomous Multi-Agent Orchestration with LangGraph + LangChain (NEW)

**Progress:** 0% (goal added, not implemented)

**Scope — fully autonomous, no human-in-the-loop.** Safety enforced by agent quorum, verifier rollback, policy classification, and hard budgets.

**Specialized agents (each a LangGraph subgraph)**
- Planner — intent → task DAG, owns replan decisions.
- Perception — DOM snapshot, a11y tree, screenshot OCR, semantic tagging.
- Navigator — routing, search, multi-tab coordination.
- Form agent — field detection, value generation, validation, submission.
- Extractor — structured scrape, schema-conforming output.
- Verifier — post-state check, replan/rollback trigger.
- Critic / guardrail — autonomous veto + reroute, structured rejection.
- Researcher — RAG over docs/web.
- Memory — owns the User Knowledge Graph (see Phase 8).

**LangGraph composition**
- Supervisor pattern: Planner routes between specialist subgraphs.
- Shared typed state (DOM snapshot, task stack, scratchpad, verifier results) flows through all nodes.
- Conditional edges: verifier fail → replan, critic reject → reroute, parser fail → reflect+retry.
- Parallel fan-out: Perception + Researcher concurrent, join at Planner.
- Per-session checkpointing keyed by `installId` + sessionId on the Phase 2 shared durable store. Enables WS reconnect recovery and time-travel debugging.
- Node-level event streaming to popup (observability only; popup cannot approve/block).

**LangChain (JS) primitives (backend only)**
- Uniform tool schemas for Gemini function calling (DOM read/click/fill/navigate/extract/fetch).
- Prompt + output-parser templates versioned by `policyVersion`; auto-retry with reflection on malformed structured output.
- Memory adapters: vector store (episodic), summary buffer (working), key-value (facts).
- Retriever for Researcher RAG.
- Multi-model routing: Gemini Pro for heavy reasoning, Flash for cheap classification, per-node tier choice.
- Callbacks → existing hashed-identity audit log.

**Autonomous safety controls (replace human gating)**
- Critic veto with structured rejection reasons.
- Verifier-driven rollback (undo last action on post-state divergence).
- Blast-radius classification: high-risk actions require quorum approval (Planner + Critic + Verifier).
- Hard budgets per session: max steps, max cost, max tool calls → graph termination.
- Anomaly detector node: OOD DOM / unexpected redirects → terminate + audit.

**Constraints**
- Gemini Live bidi audio frames stay native; LangChain/LangGraph never wrap audio.
- No LangChain deps in extension bundle (SW/content/popup).
- Tool execution authority gated by existing guardrails + signed session config.

**Open questions / blockers**
- Checkpoint store backend (Redis vs Postgres) — align with Phase 2 shared-state decision.
- Quorum protocol: serial vs parallel agent votes; tie-breaker; latency budget.
- Token + latency budget per graph node when chained with realtime voice loop.
- Rollback primitives: which DOM actions are safely reversible vs require pre-action confirmation token.

---

### Phase 8 - User Knowledge Graph (Memory Subsystem) (NEW)

**Progress:** 0% (designed, not implemented)

**Goal**
Obsidian-style typed knowledge graph per user (`installId`-scoped). Records behavior, navigation, actions, decisions, entities, preferences, and learned skills. First-class subsystem owned by the Memory agent; every other agent reads from it and emits memory events to it.

**Memory layers**
- Sensory — last N seconds DOM diff + voice transcript, ephemeral.
- Working — current session, in LangGraph shared state.
- Episodic — graph + vector dual-index of events.
- Semantic — distilled facts/preferences w/ confidence + provenance.
- Procedural — promoted Skill subgraphs reused by Planner.

**Node types**
`Session`, `Intent`, `Task`, `Subtask`, `Action`, `PageVisit`, `Domain`, `Entity` (Person/Product/Order/Address/Account/Document/...), `Observation`, `Decision`, `Preference`, `Skill`, `Concept`, `TimeAnchor`, `Failure`.

**Edge types**
`PRECEDED_BY`, `CAUSED`, `REFERS_TO`, `BELONGS_TO`, `DERIVED_FROM`, `CONTRADICTS`, `REINFORCES`, `SIMILAR_TO`, `ABSTRACTS`, `TRIGGERED_BY`, `SUPERSEDES`. Directed, weighted, timestamped.

**Storage**
Postgres + `pgvector` + Apache AGE (or recursive CTEs) + JSONB. Redis hot cache. Per-`installId` row-level tenancy.

**Write path**
Agents emit `MemoryEvent` via LangChain callbacks. Memory agent normalizes, dedupes, extracts entities, embeds, resolves coreference, PII-gates, writes nodes + edges in one transaction.

**Consolidation jobs (async)**
- Episode compaction.
- Entity resolution / coreference merge.
- Concept formation (embedding cluster → `Concept` + `ABSTRACTS`).
- Skill promotion (task DAG success ≥ N → `Skill`).
- Decay scoring `importance × recency × access_freq × confidence` → archive / purge per retention policy.
- Contradiction resolution via `SUPERSEDES`, history retained for audit.

**Read path**
LangChain `Retriever` returns typed subgraph (not flat docs). Pipeline: vector top-k seed → k-hop typed-edge expansion → importance/recency/path-weight re-rank → token-budgeted truncation. Per-agent retrieval profiles.

**Privacy + security**
- Row-level per-install isolation, no cross-tenant traversal.
- PII classifier on write; field-level AEAD encryption, key per install.
- TTL per node type.
- User endpoints: export, cascading forget (by node/edge/domain/time-range), pause-recording.
- Every read audited (agent id, query, returned node ids).
- No cross-install learning unless opt-in + DP on aggregates.

**Popup UX (observability only)**
Obsidian-like graph view, backlinks panel, search w/ unlinked-mention suggestions, manual pin/delete/edit.

**Open questions / blockers**
- Embedding model choice (latency vs quality vs cost) for high-write-volume episodic stream.
- Apache AGE vs hand-rolled adjacency in Postgres — operational overhead.
- Skill template format: serialized LangGraph subgraph vs parameterized prompt template.
- Coreference strategy for entities across domains (e.g. same Order across Amazon + Gmail).
- Retention defaults per node type; legal review for cross-jurisdiction.
- Cold-tier storage choice (S3 + manifest) and rehydration cost.

---

## Priority Next Steps (Execution Order)

1. Harden Phase 2 enrollment/rotation and shared state stores (critical security posture).
2. Complete Phase 3 transport/state-machine formalization and production fallback behavior.
3. Add Phase 5 verify-after-action loop and finish model-driven action channel.
4. Close Phase 6 with E2E/adversarial/performance evidence and observability dashboards.
5. Land Phase 7 LangGraph orchestrator + LangChain tool/prompt/memory primitives on backend (depends on Phase 2 durable store).
6. Run release gate checklist for Milestone 7.

## Reference Files

- Handoff: `new-version/HANDOFF_SUMMARY.md`
- Plan: `/Users/lucas/.cursor/plans/gemini_live_extension_rewrite_4f2d27cf.plan.md`
