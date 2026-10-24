# Architecture

RuleDeck is a small self-hosted web app: a React UI, a Node backend that alone holds the OPNsense credentials, and a shared TypeScript core with the domain model, validation, working copy, and diff logic.

```
 Browser (React)                    RuleDeck server (Fastify)              OPNsense
 ┌────────────────────┐   cookie    ┌───────────────────────────┐  HTTPS   ┌──────────────┐
 │ Rule grid          │  session +  │ auth / session / CSRF     │  Basic   │ /api/firewall│
 │ Working copy (core)│ ──────────► │ /api/* (normalized JSON)  │ ───────► │ /api/core    │
 │ Diff / review      │  CSRF hdr   │ OPNsense adapter          │  key:sec └──────────────┘
 └────────────────────┘             │ SQLite (audit, settings)  │
                                    └───────────────────────────┘
```

## Packages

The spec suggested six packages. To avoid empty packages, domain types and validation live together.

| Path | Purpose | Runs in |
|---|---|---|
| `packages/core` | Domain types, validators (IP/CIDR/port/alias name), working copy with undo/redo, diff generation, reference tracking | browser + server |
| `packages/opnsense-client` | Typed HTTP client, raw response schemas (zod), adapter raw ⇄ domain, version detection | server only |
| `apps/server` | Fastify backend: auth, sessions, CSRF, firewall registry, normalized read API, (later) apply pipeline, audit log | server |
| `apps/mock-opnsense` | Mock OPNsense API with fault injection for development and tests | dev/test |
| `apps/web` | React + Vite UI | browser |
| `tests/e2e` | Playwright acceptance tests (Phase 5) | dev/test |

Packages export their TypeScript source directly (no build step during development). The server runs via `tsx`, the web app via Vite, tests via Vitest.

## Key decisions

**Working copy lives in the browser** (`packages/core` `WorkingCopy`), persisted to `localStorage` so a reload does not lose staged edits. It holds the baseline snapshot (what was read from OPNsense) plus a list of local operations. Undo/redo replays operations. Nothing reaches the firewall until the user applies.

**The server never trusts the browser's view of the firewall.** On apply (Phase 4) the browser sends its change set and baseline fingerprints; the server re-reads OPNsense, detects conflicts, writes only the changed fields, applies, then reads back and verifies.

**Partial writes.** A modified rule is written with `set_rule` containing only the fields the user changed. OPNsense's `setNodes` leaves other fields untouched, so unknown or unsupported fields can't be lost. New and cloned rules are written with `add_rule` using every non-volatile field.

**Three change states**, shown in the UI with text labels as well as color:
1. *Staged*: local only.
2. *Written*: saved to OPNsense config (`config.xml`) but not active yet.
3. *Active*: `filter/apply` (and `alias/reconfigure` for aliases) succeeded and read-back verification passed.

**Read-only rules.** `search_rule` also returns legacy and automatic rules (non-MVC). The grid shows them for context, locked and labelled, and never writes them.

**Ordering.** Rule order comes from OPNsense's `sort_order` (derived from `prio_group` + `sequence`). Moves are only offered inside the same `prio_group` (floating / group / interface), matching `move_rule_before` restrictions.

## Grid library

| Option | License | Editing / keyboard | Clipboard | Virtualization | Notes |
|---|---|---|---|---|---|
| **TanStack Table + TanStack Virtual** | MIT | Headless; we build cells | We build it | Yes | Full control over editing, popovers, a11y. **Chosen.** |
| AG Grid Community | MIT | Good | Range copy/paste is Enterprise (paid) | Yes | Clipboard and range selection need a paid license, which rules it out |
| Glide Data Grid | MIT | Good | Good | Yes | Canvas rendering makes inline popovers and screen-reader support harder |
| Handsontable | Commercial for non-eval use | Excellent | Excellent | Yes | Paid license |

TanStack is headless, so the editing model (spec §3.3) is built in `apps/web/src/grid`. This costs more code but gives full control over the signature inline-alias interaction.

## Persistence

SQLite via Node's built-in `node:sqlite` (no native build step). It stores audit events and application settings only. Firewall credentials come from environment variables. Encrypted storage of credentials added through the UI is planned for Phase 5 (see `security.md`).

## Deployment

Docker Compose with one container (the server also serves the built web app). Bound to `127.0.0.1` by default. No external services.
