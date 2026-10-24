# Development

## Layout

```
apps/
  mock-opnsense/   Fake OPNsense API (Fastify) with fault injection
  server/          RuleDeck backend (Fastify): auth, sessions, CSRF, firewall registry, audit log
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
| `npm run hash-password` | Print a scrypt hash for `RULEDECK_ADMIN_PASSWORD_HASH` |

## Configuration in development

`apps/server/.env.development` is loaded when no `.env` exists. It points at the mock and sets the dev login `admin / ruledeck-dev`. Put a real config in `apps/server/.env` (git-ignored).

## Mock control

The mock exposes `/__mock/*` endpoints to reset state, inject faults and simulate edits by another admin. See [mock-api.md](mock-api.md). E2E tests call `POST /__mock/reset` before each test.

## Rules of the road

- Never call an OPNsense endpoint that isn't in `EP` in `packages/opnsense-client/src/client.ts`, and never add one there without recording it in `api-compatibility.md`.
- The UI works on domain objects from `packages/core`. Only the adapter knows the OPNsense field names.
- Modified rules are written with only their changed fields. Don't "round-trip" whole records.
- Every working-copy operation is a pure function with a unit test.
- No secret ever goes into a response, a log line or an audit event. `apps/server/src/app.test.ts` checks this.
