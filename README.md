# Gemini Hackaton


Production-oriented monorepo scaffold for:
- a Manifest V3 TypeScript Chrome extension
- a TypeScript backend token service
- a LangGraph-based multi-agent orchestrator (backend) using LangChain primitives for tools, prompts, memory, and guardrails

## Architecture

Three views, generated from the D2 sources in [`docs/`](docs/). Recompile after edits with `d2 docs/<name>.d2 docs/<name>.svg`. Colour = layer: extension (blue), backend (green), external Gemini Live (grey), datastores (amber), agent layer (violet).

**System** — the Chrome MV3 extension, the Express/Zod backend, and the Gemini Live service. The background service-worker `orchestrator` is the hub; numbered edges ① → ⑦ trace the runtime flow.

![System architecture](docs/architecture.svg)

**Runtime flow** — the voice-to-action loop as a sequence, step ① → ⑦.

![Runtime sequence](docs/architecture-runtime.svg)

**Agent layer** — the backend LangGraph orchestration and the user knowledge graph store. Implemented in [`packages/orchestrator`](packages/orchestrator) and wired into the backend; see [Autonomous orchestrator & knowledge graph](#autonomous-orchestrator--knowledge-graph-packagesorchestrator).

![Agent layer](docs/architecture-roadmap.svg)

## Project goals

1. Ship a hardened MV3 Chrome extension that connects the browser to Gemini Live (realtime voice + tool-use).
2. Run a TypeScript backend that mints authenticated sessions (ECDSA install identity, nonce/replay protection, rate limits, kill switch) and serves signed session config (model, voice, guardrails, policyVersion, websocket URL).
3. Operate a **fully autonomous multi-agent system** on the backend via **LangGraph** — no human-in-the-loop. Safety enforced by agent quorum, verifier rollback, policy classification, and hard budget caps.
4. Specialized agents (each a subgraph with its own state, prompts, and tools):
   - **Planner** — decomposes user voice intent into a task DAG; owns long-horizon goal and replan decisions.
   - **Perception** — DOM snapshot, accessibility tree parse, screenshot OCR, semantic element tagging.
   - **Navigator** — routing, search, link traversal, multi-tab coordination.
   - **Form agent** — field detection, value generation, validation, submission.
   - **Extractor** — structured data scrape with schema-conforming output.
   - **Verifier** — checks post-action state vs expected; triggers replan/rollback on mismatch.
   - **Critic / guardrail** — policy enforcement with autonomous veto and reroute (no human prompt).
   - **Researcher** — RAG over docs/web for context the Live model lacks.
   - **Memory** — owns the user knowledge graph: episodic writeback, entity resolution, consolidation, decay, retrieval. See "User Knowledge Graph" below.
5. LangGraph composition:
   - Supervisor pattern: Planner routes between specialist subgraphs.
   - Shared typed state object flows through all nodes (DOM snapshot, task stack, scratchpad, verifier results).
   - Conditional edges for autonomous branching (verifier fail → replan, critic reject → reroute, parser fail → reflect+retry).
   - Parallel fan-out (Perception + Researcher concurrent, join at Planner).
   - Per-session checkpointing keyed by `installId` + sessionId on the same durable store used for nonce/rate-limit state — survives WS reconnects and enables time-travel debugging.
   - Node-level event streaming to the popup for observability (watch, not approve).
6. LangChain (JS) primitives shared across agents:
   - Uniform tool schemas for Gemini function calling (DOM read/click/fill, navigate, extract, fetch).
   - Prompt + output-parser templates versioned by `policyVersion`; auto-retry with reflection on malformed structured output.
   - Memory adapters: vector store (episodic), summary buffer (working), key-value (facts).
   - Retriever abstraction for Researcher RAG.
   - Multi-model routing: heavy reasoning on Gemini Pro, cheap classification on Flash — per-node tier choice.
   - Callbacks wired to existing hashed-identity audit log.
7. Autonomous safety substitutes for human gating:
   - Critic agent veto with structured rejection reasons.
   - Verifier-driven rollback (undo last action when post-state diverges).
   - Action blast-radius classification: high-risk actions require quorum (Planner + Critic + Verifier all approve) instead of human.
   - Hard budgets per session (max steps, max cost, max tool calls) terminate the graph.
   - Anomaly detector node (out-of-distribution DOM, unexpected redirects) → terminate + audit.
8. Keep the Gemini Live bidi **audio path native** — LangChain/LangGraph operate on text + tool-use turns only. Extension bundle stays free of LangChain deps; orchestration is backend-only.

## User Knowledge Graph (memory subsystem)

First-class subsystem owned by the Memory agent. Obsidian-style typed graph per user (`installId`-scoped), recording behavior, navigation, actions, entities, decisions, preferences, and learned skills.

### Memory layers (cognitive-inspired)

- **Sensory** — last N seconds of DOM diff + voice transcript. Ring buffer. Never persisted raw.
- **Working** — current session state inside the LangGraph shared state object.
- **Episodic** — events (what happened, where, when). Graph + vector dual-index.
- **Semantic** — distilled facts, preferences, entity properties. Confidence + provenance on every node.
- **Procedural** — reusable skills mined from repeated successful task DAGs. Stored as LangGraph subgraph templates the Planner can invoke.

### Node types

`Session`, `Intent`, `Task`, `Subtask`, `Action`, `PageVisit`, `Domain`, `Entity` (Person/Product/Order/Address/Account/Document/...), `Observation`, `Decision`, `Preference`, `Skill`, `Concept`, `TimeAnchor` (daily/weekly/monthly buckets), `Failure`.

### Edge types (directed, weighted, timestamped)

`PRECEDED_BY`, `CAUSED`, `REFERS_TO`, `BELONGS_TO`, `DERIVED_FROM` (provenance), `CONTRADICTS`, `REINFORCES`, `SIMILAR_TO` (vector-similarity, Obsidian "unlinked mentions"), `ABSTRACTS` (Concept ← Instance), `TRIGGERED_BY`, `SUPERSEDES` (versioned facts, history retained).

### Storage

Single transactional store:
- Postgres + `pgvector` (embeddings) + Apache AGE or recursive CTEs (graph traversal) + JSONB (typed node payloads).
- Redis hot cache for working memory and recent episodic.
- Per-`installId` namespace, row-level tenancy, no cross-tenant traversal at the query layer.

### Write path

- Agents do **not** write directly. They emit `MemoryEvent` via LangChain callbacks.
- Memory agent normalizes, deduplicates, runs entity extraction + embedding, resolves coreference, writes nodes + edges in one transaction.
- PII classifier gate before write: hash/redact credentials, payment fields, government IDs, etc.

### Consolidation (background jobs)

- **Episode compaction** — cluster raw events into summarized episodes; drop sensory residue.
- **Entity resolution** — merge duplicate entities across sessions; canonical names.
- **Concept formation** — embedding clusters become `Concept` nodes with `ABSTRACTS` edges.
- **Skill promotion** — task DAGs succeeding ≥ N times become `Skill` nodes; Planner reuses them.
- **Decay scoring** — `score = importance × recency × access_freq × confidence`. Below threshold → cold tier; long-cold → purge (per-node-type retention policy).
- **Contradiction resolution** — newer high-confidence fact emits `SUPERSEDES`; old node retained for audit.

### Read path — hybrid graph retrieval

- LangChain `Retriever` interface returns a **subgraph** (typed JSON), not flat docs.
- Pipeline: vector top-k seed → k-hop expansion along typed edges → re-rank by importance × recency × edge-weight path score → token-budgeted truncation.
- Per-agent retrieval profiles:
  - Planner: procedural + episodic.
  - Form agent: semantic preferences + entities.
  - Researcher: domain + concept.
  - Verifier: failure history + page-visit patterns.
  - Critic: failure + anti-pattern skills.

### Privacy and security

- Per-install isolation enforced at DB row level and query layer.
- Field-level encryption (AEAD) for sensitive payloads, key per install.
- TTL per node type (short for `PageVisit`, long for `Preference`).
- User endpoints: full export, cascading forget (by node / edge / domain / time-range), pause-recording.
- Every retrieval audited (agent id, query, returned node ids).
- No cross-install learning unless opt-in with differential privacy on aggregates.

### Popup UX (observability only)

- Obsidian-style graph view, filterable by node type / domain / time.
- Backlinks panel per node.
- Search with unlinked-mention suggestions.
- Manual pin / delete / edit (user is source of truth).

### Long-term payoffs

- Planner skips rediscovery via `Skill` matches.
- Form agent autofills from `Preference` graph instead of page heuristics.
- Researcher grounds Gemini answers in the user's own history.
- Verifier flags anomalies via `PageVisit` topology.
- Critic blocks known-bad patterns from `Failure` history.

## Workspace layout

- `packages/extension`: MV3 Chrome extension (background service worker, content script, popup)
- `packages/backend`: Node.js TypeScript token service + orchestrator/memory HTTP surface
- `packages/orchestrator`: backend-only LangGraph autonomous multi-agent orchestrator over the User Knowledge Graph

## Autonomous orchestrator & knowledge graph (`packages/orchestrator`)

A self-contained, backend-only package built on real `@langchain/langgraph` and `pg` + `pgvector`, behind clean ports so the deterministic defaults (used everywhere by default and in CI) can be swapped for production adapters with no graph changes.

**Orchestration graph** (`src/graph`):
- LangGraph `StateGraph` with a shared typed state, the supervisor pattern (Planner routes specialists), parallel Perception ‖ Researcher fan-out joined at the Planner, and conditional edges (verifier fail → replan, critic reject → reroute).
- Nine agent nodes: Planner, Perception, Researcher, Navigator, Form, Extractor, Verifier, Critic, Memory.
- Autonomous safety: Critic veto + blast-radius classification, **quorum** (Planner + Critic + Verifier) for high-risk actions, Verifier-driven rollback, hard per-session budgets (steps / tool calls / cost), and an anomaly detector that terminates + audits.
- Per-session checkpointing (LangGraph `MemorySaver` by default; swap a durable saver) and a node-level event stream exposed as an SSE endpoint for observability (watch, never approve). The endpoint is live; the extension popup view that consumes it is not yet wired.
- Ports: `ChatModel` (multi-model `pro`/`flash` routing + structured-output reflection retry), `ActionExecutor` (the `SimulatedActionExecutor` by default; production dispatches AgentActions to the extension), `Embedder`.

**User Knowledge Graph** (`src/memory`):
- Typed nodes/edges with a `GraphStore` port: `InMemoryGraphStore` (default/tests) and `PostgresGraphStore` (Postgres + `pgvector` + JSONB, row-level per-install tenancy).
- Write path: normalize → dedupe by natural key → entity extraction + embedding → coreference (merge / `SIMILAR_TO`) → **PII gate** (redact credentials, AEAD-seal financial/gov-ID fields per-install, hash contacts, scrub embedded PII) → one atomic batch.
- Hybrid retrieval: vector top-k seed → k-hop typed-edge expansion → importance × recency × path-weight re-rank → token-budgeted typed subgraph, with per-agent retrieval profiles and audited reads.
- Consolidation jobs: episode compaction, entity resolution, concept formation, skill promotion, decay (cool → purge), contradiction resolution (`SUPERSEDES`).
- Privacy surface: full export (optional unseal), cascading forget (node / edge / domain / time-range), pause-recording.

### Backend endpoints

All require the `Authorization: Bearer <session credential>` minted by `/api/session-init`; every endpoint is scoped to the token's `installId`.

- `POST /api/orchestrate` — run the autonomous graph for an intent (`{ sessionId, intent, snapshot?, budget? }`); returns the run outcome + node events.
- `GET  /api/orchestrate/:runId/events` — Server-Sent Events replay/stream of node-level events for a run.
- `POST /api/memory/export` — full knowledge-graph export (`{ unseal? }`).
- `POST /api/memory/forget` — cascading forget (`{ scope: { kind: node|edge|domain|timeRange, ... } }`).
- `POST /api/memory/pause` — pause/resume recording (`{ paused }`).
- `GET  /api/memory/graph` — read-only typed subgraph for the popup observability view.

## Prerequisites

- Node.js 20+
- npm 10+

## Install

```bash
pnpm install
```

## Build all packages

```bash
pnpm -r build
```

## Build extension unpacked output

```bash
pnpm --filter @gemini-hackaton/extension build
```

Unpacked extension output is generated in:
- `packages/extension/dist`

Load it in Chrome:
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked"
4. Select `packages/extension/dist`

## Run backend in dev mode

```bash
pnpm --filter @gemini-hackaton/backend dev
```

## Placeholder quality scripts

```bash
pnpm -r lint
pnpm -r test
pnpm -r typecheck
```

## Configuration notes

- Update extension CSP `connect-src` endpoints in `packages/extension/public/manifest.json`
- Set backend env vars in `packages/backend/.env` (see `.env.example`)
- `SESSION_CREDENTIAL_SIGNING_SECRET` in `.env.example` is a dev placeholder; replace it before any shared deployment
- `SESSION_MINTING_ENABLED=false` provides an emergency stop switch for session issuance

Orchestrator + knowledge-graph backend env vars (all have safe local defaults; replace secrets before any shared deployment):

- `MEMORY_ENCRYPTION_KEY` — master secret for AEAD field-level encryption of sensitive knowledge-graph payloads (per-install key derived via HKDF). **Replace the dev default before any shared deployment.**
- `DATABASE_URL` — optional Postgres connection string; when set, the knowledge graph uses Postgres + `pgvector`, otherwise an in-memory store.
- `EMBED_DIMS` — embedding vector dimension (must match the Postgres `vector(N)` column; default `64`).
- `ORCH_MAX_STEPS` / `ORCH_MAX_TOOL_CALLS` / `ORCH_MAX_COST_MICROS` — hard per-session orchestration budgets.
- `ORCH_BLOCKED_DOMAINS` — comma-separated domains the Critic hard-vetoes.

## Operations

- Incident and emergency procedures: `docs/OPERATIONS_RUNBOOK.md`
- Pre-release validation gates: `docs/RELEASE_CHECKLIST.md`
