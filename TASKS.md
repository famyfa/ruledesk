# RuleDeck — Task Checklist

Split from [Instructions.md](Instructions.md). Checked items are done; unchecked items are open.
Work order follows section 15 of the spec: discovery docs first, then Phase 1, then the smallest useful Phase 2.

## 0. Repo setup
- [x] Init git repo, point `origin` at github.com/famyfa/ruledesk
- [x] Monorepo scaffold (npm workspaces, TypeScript, lint/test tooling)
- [ ] `.gitignore`, `README.md`, `PROJECT.md`, `CLAUDE.md`
- [ ] First commit + push

## 1. Discovery & planning (spec §15)
- [x] Architecture proposal — `docs/architecture.md`
- [x] OPNsense API compatibility matrix (verified against official docs) — `docs/api-compatibility.md`
- [x] Field mapping: OPNsense rule/alias ↔ domain model — `docs/field-mapping.md`
- [x] Threat model (credentials, sessions, privileged ops) — `docs/security.md`
- [x] Mock API specification — `docs/mock-api.md`
- [ ] Executable acceptance tests for inline alias creation + rule editing
- [x] Unresolved API questions & compatibility risks — `docs/open-questions.md`
- [x] Grid library choice documented (keyboard, clipboard, virtualization, a11y, license)

## 2. Phase 1 — Foundation
- [x] `packages/core` domain types: FirewallRule, Alias, AddressSpec, PortSpec
- [x] `packages/core` validators: IPv4/IPv6/CIDR/port/alias-name/alias entries + unit tests
- [x] `packages/opnsense-client`: typed HTTP client (Basic auth key/secret, TLS verify on)
- [x] Adapter: raw OPNsense rule/alias → domain, and back, keeping unknown fields (`rawFields`)
- [x] Normalization/serialization unit tests
- [x] Version detection at connect time + feature flags per version
- [x] Mock OPNsense API server (success, validation errors, conflicts, timeouts, partial failures, unsupported endpoints)
- [ ] `apps/server`: Fastify backend, config from env, secrets never sent to browser
- [ ] Authentication for the RuleDeck UI (session cookie, CSRF protection)
- [ ] Firewall connection config (env-injected; no arbitrary URL fetching)
- [ ] Read-only endpoints: rules, aliases, interfaces, selection options
- [x] Basic error handling + API error mapping (with tests)
- [ ] Local dev environment (`npm run dev` runs mock + server + web)

## 3. Phase 2 — Spreadsheet rule editor (smallest working version)
- [ ] `apps/web`: React + TS + Vite shell (sidebar, toolbar, grid area, details panel, drawer)
- [ ] Dark/light theme, dense table styling, visible focus
- [ ] Read-only rule grid in real firewall order (sticky header + id columns)
- [ ] Filtering and search
- [x] Local working copy store (no writes to firewall)
- [ ] Inline cell editing (click/Enter/Escape/Tab/Shift+Tab, arrow keys)
- [ ] Modified / invalid / unchanged cell indicators
- [x] Undo / redo (with unit tests)
- [ ] Rule cloning (placed after original, marked pending add)
- [x] Diff generation in admin-readable form (with unit tests)
- [ ] Pending-changes count + diff preview drawer

## 4. Phase 3 — Alias-first workflow (signature feature)
- [ ] Alias autocomplete in source/destination cells (shows object type)
- [ ] "Create alias" inline popover (name, type, entries, description)
- [ ] Alias validation (name, duplicates, malformed entries, pasted newline lists)
- [ ] New alias immediately usable in the working copy
- [ ] Edit alias inline without leaving the rule
- [ ] Reference tracking; block deletion of referenced aliases unless acknowledged
- [ ] Alias management page
- [ ] Alias types discovered from API, not hard-coded

## 5. Phase 4 — Safe deployment
- [ ] Validate all pending changes before apply
- [ ] Concurrent-modification detection (conflict view: discard / reconcile / recreate)
- [ ] Review screen: adds, modifies, deletes, reorders; lockout-risk warnings
- [ ] Explicit confirmation before apply
- [ ] Apply via verified API calls (savepoint → apply → confirm where supported)
- [ ] Read back + verify result; staged vs written vs active states shown
- [ ] Audit log (who, what, outcome; no secrets) in a small DB
- [ ] Recovery guidance after partial failures
- [ ] Rule reordering (drag-and-drop + keyboard), within supported groups only
- [ ] Bulk editing (action, logging, enable/disable, description) with per-row validation

## 6. Phase 5 — Quality & packaging
- [ ] E2E test: the full "add rule → inline alias → review → apply → reload" flow
- [ ] Docker Compose deployment (no cloud deps, not exposed publicly by default)
- [ ] Backup/restore of RuleDeck settings
- [ ] Encrypted credential storage with documented key strategy
- [ ] Rate limiting on sensitive routes
- [ ] Version compatibility checks against real OPNsense instances
- [ ] Security review
- [ ] Usability polish
- [ ] Docs: development.md, README updated
