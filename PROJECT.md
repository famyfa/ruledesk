# Project status

The full product spec is in [Instructions.md](Instructions.md). The task checklist is in [TASKS.md](TASKS.md).

## Discovery (done)

Delivered in `docs/`: architecture, API compatibility matrix for OPNsense 26.7 and 26.1 (checked against the source at tags 26.7.7 and 26.1.11), field mapping, threat model, mock API spec, open questions and risks. Executable acceptance tests are in `tests/e2e/inline-alias.spec.ts`.

Key findings that shaped the design:

- **OPNsense 26.7 removed the savepoint / auto-rollback API** (`filter/savepoint`, `apply/{revision}`, `cancel_rollback`, `revert`). 26.1 still has it. Lockout protection on 26.7 has to come from warnings on the review screen and the config history API (`core/backup/*`).
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

## Phase 4: Safe deployment (next)

Not started: conflict detection at apply time, review screen with lockout warnings, writes (alias → rules → moves → apply), read-back verification, audit events for applies, recovery guidance.

## Phase 5: Quality and packaging

Not started: Docker Compose, settings backup, live OPNsense compatibility runs, security review.
