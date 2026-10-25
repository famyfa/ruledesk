# CLAUDE.md

RuleDeck: spreadsheet-first OPNsense rule editor. The product spec is [Instructions.md](Instructions.md). Progress is tracked in [TASKS.md](TASKS.md). Check items off there as they're finished.

## Commands

- `npm run dev`: 2 mock firewalls (8443 Berlin, 8444 Munich) + server (3000) + web (5173). Sign in as `admin / ruledeck-dev` (a mock OPNsense account)
- `npm test`: Vitest (unit + integration against an in-process mock)
- `npx playwright test`: E2E on its own stack with the two MOCK firewalls (pinned, never your real config)
- `npm run typecheck`: all workspaces

## Structure

- `packages/core`: domain types, validators, working copy (pure functions, undo/redo), diff, validation. Shared by browser and server
- `packages/opnsense-client`: HTTP client, zod response schemas, adapter (raw ⇄ domain), version feature flags
- `apps/server`: Fastify. Stores NOTHING (no DB, no credentials). Users sign in with OPNsense accounts; per-site firewall sessions live in memory (`auth.ts`, `sites.ts`). Sites come from a read-only topology file (`topology.ts`)
- `apps/mock-opnsense`: mimics OPNsense 26.7 endpoints, `/__mock/*` for test control
- `apps/web`: React. Grid (view/select/reorder/copy-paste) in `src/grid`; editing happens in dialogs in `src/forms` (rule editor with tabs, alias form); workspace state in `src/workspace.tsx`

## Rules

- Never invent OPNsense endpoints or payloads. Verify against the OPNsense source/docs for the target release and record it in `docs/api-compatibility.md`.
- No automatic rollback (decided; don't reintroduce). Recovery = OPNsense config history. Feature-flag anything version-specific (`packages/opnsense-client/src/version.ts`).
- Rules reference aliases **by name**. Rule order = `prio_group` + `sequence`. Moves only within the same `prio_group`.
- Legacy/automatic rules (from `search_rule` without uuid) are read-only.
- Updates send only changed fields (`ruleChangedFields`). Unknown fields live in `extra` and must survive.
- Never claim a change is applied/active without reading it back.
- Never put secrets in responses or logs. Never add server-side storage (product decision).
- Write tests with every feature. Keep the app runnable after each step.
