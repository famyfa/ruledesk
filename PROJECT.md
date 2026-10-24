# Project status

The full product spec is in [Instructions.md](Instructions.md). The task checklist is in [TASKS.md](TASKS.md).

## Discovery (done)

Delivered in `docs/`: architecture, API compatibility matrix for OPNsense 26.7 and 26.1 (checked against the source at tags 26.7.7 and 26.1.11), field mapping, threat model, mock API spec, open questions and risks. Executable acceptance tests are in `tests/e2e/inline-alias.spec.ts`.

Key findings that shaped the design:

- **No automatic rollback.** 26.7 removed the savepoint/rollback API, and we decided not to use it on 26.1 either. Lockout protection comes from warnings on the review screen; recovery is OPNsense config history.
- Rules reference aliases **by name**. Renaming an alias through the API rewrites references in rules.
- `search_rule` also returns legacy and automatic rules. RuleDeck shows them read-only.
- Order is `prio_group` (floating 200000, groups 300000+, interfaces 400000) plus `sequence`. `move_rule_before` refuses cross-group moves.
- A saved rule is in `config.xml` immediately, and `filter/apply` activates it. That gives the three states the spec asks for: staged → written → active.

## Phase 1: Foundation (done)

**Works:** monorepo, mock OPNsense with fault injection, typed read-only client with response validation and error mapping, version detection with feature flags, Fastify server with login (scrypt), sessions, CSRF, login rate limit, security headers, SQLite audit log, and read-only endpoints for rules, aliases, interfaces and options.

**Tested:** adapter round-trips (unknown fields kept), URL and path safety, error mapping (auth, 404, 500, timeout, refused), server auth/CSRF/rate limit, and a check that the secret never appears in any response.

**Not done:** encrypted storage for credentials entered in the UI (env-only for now), multi-firewall config (the registry supports it, config loads one).

## Phase 2: Spreadsheet editor (done)

**Works:** virtualized grid in evaluation order, filters, keyboard navigation, inline editors for every column, multi-cell copy/paste, undo/redo, clone, add, delete, reorder by drag-and-drop and Alt+↑/↓ within a group, bulk edit, details panel with advanced fields, change indicators, diff drawer, and a working copy that survives reloads.

**Tested:** 87 unit tests in `packages/core` (working copy, undo/redo, ordering, diff, validation, address parsing).

## Phase 3: Alias-first workflow (done)

**Works:** address/port autocomplete with object types and alias previews, "Create alias" from inside the cell with a popover (paste lists, live validation, duplicate removal), aliases usable immediately, alias edit from a chip, alias page with reference lists, and a delete guard that leaves referencing rules flagged instead of turning them into "any".

**Tested:** Playwright acceptance test for the full inline-alias workflow up to the diff, plus reload persistence.

## Phase 4: Safe deployment (done, mock only)

**Works:** review screen with counts, plan explanation and lockout warnings (with acknowledgement), explicit confirmation, server-side re-read and conflict detection (field-level for changed objects, plus a whole-group check before reordering), writes in a safe order with only changed fields, ordering through `sequence` with minimal renumbering, activation, read-back verification, per-step result with Written / Activated / Verified labels, recovery steps for every failure mode, a "keep my changes on top of the firewall" reconcile path, and audit events for every apply.

**Safety switch:** writes are refused unless `RULEDECK_ALLOW_WRITES=true` (only set for the mock in development).

**Tested:** 10 server tests against the mock (success, reorder/delete/update, conflicts by edit, reorder and name clash, partial write failure, activation failure, invalid data, risk acknowledgement, alias delete), 15 core tests for ordering/rebase/risk, and E2E tests for the full flow (add rule → inline alias → review → apply → reload → still linked) and the conflict/reconcile flow.

**Not done:** nothing has been run against a real OPNsense yet.

## Phase 5: Quality and packaging

Started: Dockerfile and `docker-compose.yml` (localhost-only, read-only rootfs, no capabilities). Production mode (server serving the built UI) is tested, but the image build itself isn't yet. Not started: settings backup, encrypted credential storage, live OPNsense compatibility runs, security review.
