# CLAUDE.md

RuleDeck: spreadsheet-first OPNsense rule editor. The product spec is [Instructions.md](Instructions.md). Progress is tracked in [TASKS.md](TASKS.md). Check items off there as they're finished.

## Commands

- `npm run dev`: mock firewall (8443) + server (3000) + web (5173). Login `admin / ruledeck-dev`
- `npm test`: Vitest (unit + integration against an in-process mock)
- `npx playwright test`: E2E against the dev stack
- `npm run typecheck`: all workspaces

## Structure

- `packages/core`: domain types, validators, working copy (pure functions, undo/redo), diff, validation. Shared by browser and server
- `packages/opnsense-client`: HTTP client, zod response schemas, adapter (raw ⇄ domain), version feature flags
- `apps/server`: Fastify. Session cookie + `x-csrf-token` header on non-GET requests. Only component holding API secrets
- `apps/mock-opnsense`: mimics OPNsense 26.7 endpoints, `/__mock/*` for test control
- `apps/web`: React. Grid in `src/grid`, workspace state in `src/workspace.tsx`

## Rules

- Never invent OPNsense endpoints or payloads. Verify against the OPNsense source/docs for the target release and record it in `docs/api-compatibility.md`.
- 26.7 removed `filter/savepoint|revert|cancel_rollback`. Feature-flag anything version-specific (`packages/opnsense-client/src/version.ts`).
- Rules reference aliases **by name**. Rule order = `prio_group` + `sequence`. Moves only within the same `prio_group`.
- Legacy/automatic rules (from `search_rule` without uuid) are read-only.
- Updates send only changed fields (`ruleChangedFields`). Unknown fields live in `extra` and must survive.
- Never claim a change is applied/active without reading it back.
- Never put secrets in responses, logs or audit events.
- Write tests with every feature. Keep the app runnable after each step.
