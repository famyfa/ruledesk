# Development

How to run, test and change RuleDeck. For the big picture read [architecture.md](architecture.md) first; for the workflow (branches, pull requests) see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Setup

Node.js 22.13 or newer.

```sh
npm install
npm run dev        # two mock firewalls + server + web app
```

Open http://127.0.0.1:5173 and sign in with **admin / ruledeck-dev** (or **viewer / viewer-pass** for a read-only account). No real firewall needed.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Mock firewalls, server and web app, all reloading on change |
| `npm test` | Vitest: unit tests and integration tests against an in-process mock (about 2 s) |
| `npx playwright test` | End-to-end tests on their own stack (about 1 min). First time: `npx playwright install chromium` |
| `npm run typecheck` | `tsc` in every workspace |
| `npm run build` | Production build of the web app (`apps/web/dist`) |
| `npm run fingerprint -- <host>` | Print a firewall's certificate fingerprint for the topology file |
| `docker build -t ruledeck:local .` | The production image |

## Ports

| Stack | Web | Server | Mock firewalls |
|---|---|---|---|
| `npm run dev` (development, or a lab via `apps/server/.env`) | 5173 | 3000 | 8443, 8444 |
| `npx playwright test` (started and stopped by Playwright) | 5273 | 3100 | 9443, 9444 |

The E2E stack has its own ports and topology (`apps/server/topology.e2e.json`), so tests can run while a dev or lab stack keeps running.

`npm run dev` restarts the server when server code changes (in-memory sessions are lost), reloads the page when web code changes, and React's development mode runs every effect twice. For hands-on testing that shouldn't be interrupted, run the production image (see [install.md](install.md)), e.g. on port 8080.

## Configuration in development

`apps/server/.env.development` is used when no `apps/server/.env` exists. It points at `apps/server/topology.dev.json` (two mock sites, each with a simulated HA peer). To try a real lab, put your own settings in `apps/server/.env` and `ruledeck.topology.json` (both git-ignored).

## The mock firewall

`apps/mock-opnsense` imitates the OPNsense API: rules, aliases, categories, the services in the catalogue, CARP, the firewall log, GUI sign-in with privileges, and an HA peer. Tests control it through `/__mock/*` (reset, fault injection, edits "made elsewhere", log lines, CARP state). See [mock-api.md](mock-api.md). E2E tests reset it before each test.

When you add or change an OPNsense call, change the mock the same way, after checking the real behavior.

## How to …

**… add an OPNsense endpoint.** Read the controller in the OPNsense source for the target release (`src/opnsense/mvc/app/controllers/OPNsense/<Module>/Api/`). Add the path to `EP` in `packages/opnsense-client/src/client.ts` and a typed method next to the others. Record it in [api-compatibility.md](api-compatibility.md) (what you checked, and later the live check). Teach the mock the same behavior. Write a client integration test.

**… add a service** (settings or tables that follow OPNsense's MVC pattern). Add one entry to `SERVICES` in `packages/core/src/service-catalog.ts`: endpoints, table roots, columns, name and key fields, multi-select fields, reconfigure endpoint. Check that secret fields match `isSecretField` (or extend it). Seed some data in `apps/mock-opnsense/src/services.ts`. Add it to the table in [services.md](services.md) and [api-compatibility.md](api-compatibility.md). The page, the forms, the sync and the apply come for free.

**… add a page.** Create it in `apps/web/src/pages`, add its `Page` id and tab/tree entry in `components/Shell.tsx`, and render it in `App.tsx`. Use `useWorkspace()` for the open site; use `components/icons.tsx` for icons (no emoji).

**… add a server route.** Put it in the matching module in `apps/server/src/routes/`. Validate every input with zod, use `ctx.siteFor` / `ctx.withSite`, and for anything that writes: `ctx.allowChange` and `ctx.writesAllowed`, and the per-site lock in `sites.ts`. Authentication and CSRF are applied to every `/api/*` route automatically (`app.ts`); public routes must be listed in `PUBLIC_ROUTES`.

## Rules of the road

- Never call an OPNsense endpoint that isn't in `EP`, and never add one without recording it in `api-compatibility.md`.
- The UI works on domain objects from `packages/core`. Only the adapter knows OPNsense field names.
- Write only changed fields. Never round-trip whole records; unknown fields must survive.
- Every working-copy operation is a pure function with a unit test.
- No secret in a response, a log line or browser storage. RuleDeck stores nothing on the server.
- Never claim something is applied without reading it back.
- No automatic rollback (decided).
- Tests with every feature: unit tests in `core`, server tests against the in-process mock, an E2E test for user-visible behavior.
