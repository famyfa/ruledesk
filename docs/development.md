# Development

## Layout

```
apps/
  mock-opnsense/   Fake OPNsense API (Fastify) with fault injection
  server/          RuleDeck backend (Fastify): OPNsense sign-in, in-memory sessions, CSRF, topology, apply
  web/             React UI (Vite)
packages/
  core/            Domain model, validators, working copy, diff, validation (browser + node)
  opnsense-client/ Typed OPNsense client and adapter (node only)
tests/e2e/         Playwright acceptance tests
docs/              Design docs
```

Packages export TypeScript source directly, so there is no build step during development. `tsx` runs the server and mock. Vite bundles the web app.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | mock + server + web with reload |
| `npm test` | Vitest: unit tests and client/server integration tests against an in-process mock |
| `npx playwright test` | E2E tests. Reuses a running `npm run dev` or starts one |
| `npm run typecheck` | `tsc` in every workspace |
| `npm run build` | Production build of the web app (`apps/web/dist`) |

## Configuration in development

`apps/server/.env.development` is loaded when no `.env` exists. It uses `apps/server/topology.dev.json` (two mock sites). Sign in as `admin / ruledeck-dev`, or `viewer / viewer-pass` for a read-only account. Put a real config in `apps/server/.env` (git-ignored).

## Mock control

The mock exposes `/__mock/*` endpoints to reset state, inject faults and simulate edits by another admin. See [mock-api.md](mock-api.md). E2E tests call `POST /__mock/reset` before each test.

## Rules of the road

- Never call an OPNsense endpoint that isn't in `EP` in `packages/opnsense-client/src/client.ts`, and never add one there without recording it in `api-compatibility.md`.
- The UI works on domain objects from `packages/core`. Only the adapter knows the OPNsense field names.
- Modified rules are written with only their changed fields. Don't "round-trip" whole records.
- Every working-copy operation is a pure function with a unit test.
- No secret ever goes into a response or a log line (`apps/server/src/app.test.ts` checks this). RuleDeck stores nothing on the server.

## Ports

| Stack | Web | Server | Mock firewalls |
|---|---|---|---|
| `npm run dev` (development, or a lab via `apps/server/.env`) | 5173 | 3000 | 8443, 8444 |
| `npx playwright test` (E2E, started and stopped by Playwright) | 5273 | 3100 | 9443, 9444 |

The E2E stack has its own ports and topology (`apps/server/topology.e2e.json`), so tests can run while a dev or lab stack keeps running.

`npm run dev` restarts the server whenever server code changes (in-memory sessions are lost) and reloads the page whenever web code changes, and React's development mode runs every effect twice. For hands-on testing that shouldn't be interrupted, run the production image instead (see docs/install.md), e.g. on port 8080.

