# Architecture

RuleDeck is a small self-hosted web app: a React UI, a Node server that alone talks to the firewalls, and a shared TypeScript core. The server **stores nothing**; everything comes from the firewalls, from the user's browser tab, or from two read-only config files.

```
 Browser (React)                      RuleDeck server (Fastify)                 OPNsense (per site, HA primary)
 ┌──────────────────────────┐ cookie  ┌──────────────────────────────┐  HTTPS   ┌───────────────────────┐
 │ pages, grid, forms       │ + CSRF  │ auth + CSRF (app.ts)         │ pinned   │ /api/firewall/...     │
 │ working copies (core)    │ ──────► │ routes/*  (validated input)  │ ───────► │ /api/kea, /unbound,...│
 │  - per site (rules)      │  JSON   │ apply pipelines (re-read,    │ session  │ /api/diagnostics/...  │
 │  - shared policy         │         │   write, activate, read back)│ or key   └───────────────────────┘
 │  - per service           │         │ in-memory sessions only      │
 │ sessionStorage drafts    │         └──────────────────────────────┘
 └──────────────────────────┘                     ▲ read-only: topology file, env
```

## Code map

| Path | What lives there |
|---|---|
| `packages/core` | Everything that is pure logic and runs in browser and server: domain types (`domain.ts`), validation, the **working copy** with undo/redo (`working-copy.ts`), change sets (`diff.ts`), rule ordering, conflict rebase, lockout heuristics (`risk.ts`), filter expressions (`filter*.ts`), cross-site sync (`sync.ts`), the **shared policy** (`shared.ts`), the generic **service model** and its catalogue (`service.ts`, `service-catalog.ts`, `service-sync.ts`), HA decisions (`ha.ts`) |
| `packages/opnsense-client` | The only code that speaks OPNsense: `http.ts` (TLS verification/pinning, timeouts, size cap, error mapping), `login.ts` (GUI sign-in like a browser), `client.ts` (every endpoint in one `EP` table, typed methods), `adapter.ts` (raw OPNsense records ⇄ domain objects), `version.ts` (feature flags per release) |
| `apps/server` | `app.ts` (security headers, auth + CSRF for every route, error mapping), `routes/` (one module per area: auth, sites, services, ha, shared), the apply pipelines (`apply.ts`, `service-apply.ts`, `shared-apply.ts`, `ha.ts`), sessions and rate limits (`auth.ts`), sign-in and the per-site lock (`sites.ts`), config and topology |
| `apps/web` | `App.tsx` (routing), `components/Shell.tsx` (top tabs, left tree, toolbar), `workspace.tsx` (the open site), `shared.tsx` (shared policy scope), `pages/`, `grid/` (the rule table), `forms/` (rule editor), `components/` (dialogs, icons) |
| `apps/mock-opnsense` | A fake OPNsense that follows the real API closely enough for all tests: rules, aliases, categories, services, CARP, log, HA peer, sign-in, privileges, fault injection (`/__mock/*`) |
| `tests/e2e` | Playwright tests against the mock, on their own ports |

Packages export TypeScript source directly; there is no build step except the web app.

## How a change flows

The same pattern is used everywhere (rules, services, shared policy, HA):

1. **Read.** The browser asks for a snapshot; the server reads the firewall and returns domain objects. Secrets are removed on the server.
2. **Stage.** Edits change a *working copy* in the browser (pure functions in `core`). It is saved to `sessionStorage` (this tab only, no secrets) so a reload doesn't lose work.
3. **Review.** A change set is computed by comparing the working copy with its baseline.
4. **Apply.** The browser sends baseline + current state. The server doesn't trust either: it re-reads the firewall, refuses on conflicts (fingerprints), validates against the live firewall, writes in a safe order with **only changed fields**, activates (`filter/apply`, `reconfigure`), and reads back to verify.
5. **No automatic rollback** (decided). Every step is reported; recovery is the firewall's configuration history.

Only one change runs per site at a time (`withSiteLock` in `sites.ts`): rule apply, service apply and HA switch never overlap.

## Three ideas worth knowing

**Working copies are pure data.** `WorkingCopy` = baseline snapshot + current state + undo/redo stacks. Every edit is a function `(wc) => wc` in `core`, which makes them easy to test and to replay (rebase onto a newer firewall state).

**Shared policy = same uuid everywhere.** A shared rule or alias carries the "RuleDeck shared" category and has the same uuid on every site (OPNsense's `set_*` endpoints create by uuid). The browser builds one shared view from all sites (`buildSharedView`); edits use logical interface names; the server projects the shared change onto each site with that site's interface map (`projectToSite`) and applies site by site, stopping at the first failure.

**Services are data, not code.** Each OPNsense service is one entry in `service-catalog.ts` (endpoints, tables, columns, key fields). The client reads any of them the same way (OPNsense's MVC pattern), flattens them to `field -> string` maps, and the UI builds forms from the firewall's own model. Adding a service is usually one catalogue entry plus a mock seed and a test.

## Persistence and state

| Where | What |
|---|---|
| Server memory | RuleDeck sessions (cookie id, CSRF token) and, per site, the firewall session or API key. Lost on restart, by design |
| Browser `sessionStorage` | Staged working copies (rules per site, shared policy, services). No secrets. Cleared at sign-out |
| Browser `localStorage` | Theme only |
| Files (read-only) | Topology (sites, URLs, pins, interface maps) and env settings. No secrets |
| Firewalls | Everything else, including the audit trail (config history under the signed-in user) |

## Decisions and why

- **No database, no stored credentials, no local users.** Less to protect, nothing to back up, identity and permissions come from OPNsense (LDAP/RADIUS/TOTP work as they do there).
- **No automatic rollback.** OPNsense 26.7 removed the savepoint API; a home-made rollback would be a second source of truth. Config history is the recovery.
- **Writes only to the HA primary.** The peer gets changes through OPNsense's own HA sync.
- **TLS verification can't be switched off.** Self-signed certificates are pinned by fingerprint instead.
- **Purpose-built grid** (on TanStack Virtual) instead of a grid library: full control over keyboard, clipboard, drag and drop and accessibility, and no paid features needed.
- **Every endpoint verified** against the OPNsense source for the target release and recorded in `api-compatibility.md`; nothing is guessed.
