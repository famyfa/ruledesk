# CLAUDE.md

RuleDeck: centralized management UI for OPNsense (rules, aliases, services, multi-site). How it works: [docs/architecture.md](docs/architecture.md); contributing: [CONTRIBUTING.md](CONTRIBUTING.md). The original spec is in [docs/history/](docs/history/). Progress is tracked in [TASKS.md](TASKS.md). Check items off there as they're finished.

## Commands

- `npm run dev`: 2 mock firewalls (8443 Berlin, 8444 Munich) + server (3000) + web (5173). Sign in as `admin / ruledeck-dev` (a mock OPNsense account)
- `npm test`: Vitest (unit + integration against an in-process mock)
- `npx playwright test`: E2E on its own stack with the two MOCK firewalls (pinned, never your real config) on its own ports (web 5273, server 3100, mocks 9443/9444), so a running dev/lab stack is never touched
- `npm run typecheck`: all workspaces

## Structure

- `packages/core`: domain types, validators, working copy (pure functions, undo/redo), diff, validation, filter expressions, shared policy (`shared.ts`), service model + catalogue (`service*.ts`), HA rules (`ha.ts`). Shared by browser and server
- `packages/opnsense-client`: HTTP client (TLS pinning, size cap), zod response schemas, adapter (raw ⇄ domain), version feature flags, every endpoint in `EP` (`client.ts`)
- `apps/server`: Fastify. Stores NOTHING (no DB, no credentials). `app.ts` = security hooks + auth/CSRF; routes per area in `src/routes/`; apply pipelines in `apply.ts`, `service-apply.ts`, `shared-apply.ts`, `ha.ts`; per-site lock in `sites.ts`; read-only topology in `topology.ts`
- `apps/mock-opnsense`: mimics OPNsense 26.7 endpoints (rules, aliases, services, CARP, log), `/__mock/*` for test control
- `apps/web`: React. Grid in `src/grid`; dialogs in `src/forms`; pages in `src/pages`; per-site state in `src/workspace.tsx`, shared policy state in `src/shared.tsx`, service drafts in `src/serviceDrafts.ts`; icons only via `src/components/icons.tsx`

## Rules

- Never invent OPNsense endpoints or payloads. Verify against the OPNsense source/docs for the target release and record it in `docs/api-compatibility.md`.
- No automatic rollback (decided; don't reintroduce). Recovery = OPNsense config history. Feature-flag anything version-specific (`packages/opnsense-client/src/version.ts`).
- Rules reference aliases **by name**. Rule order = `prio_group` + `sequence`. Moves only within the same `prio_group`.
- Legacy/automatic rules (from `search_rule` without uuid) are read-only.
- Updates send only changed fields (`ruleChangedFields`). Unknown fields live in `extra` and must survive.
- Never claim a change is applied/active without reading it back.
- Never put secrets in responses or logs. Never add server-side storage (product decision).
- Write tests with every feature. Keep the app runnable after each step.
