# Backend session-init endpoint

This package exposes `POST /api/session-init` for Gemini Live bootstrap.

## Security model

- Install registration endpoint binds a public key to each install ID.
- Session-init requests are authenticated with install-private-key signatures over `installId\ntimestamp\nnonce`.
- Replay protection with an in-memory nonce cache and TTL window.
- Timestamp staleness check to enforce a bounded auth window.
- In-memory rate limiting on both source IP and `installId`.
- Structured error responses for auth, replay, staleness, and rate-limit failures.
- Session credentials are short-lived signed tokens (JWT-like) generated server-side.

## Run

1. Copy `.env.example` to `.env` and set `SESSION_CREDENTIAL_SIGNING_SECRET`.
2. Install dependencies from the monorepo root:
   - `npm install`
3. Start backend dev server:
   - `npm run dev -w @gemini-hackaton/backend`

## Test

- `npm run test -w @gemini-hackaton/backend`
