# RuleDeck — Task Checklist

Split from [Instructions.md](Instructions.md). Checked items are done; unchecked items are open.
Work order follows section 15 of the spec: discovery docs first, then Phase 1, then the smallest useful Phase 2.

## 0. Repo setup
- [x] Init git repo, point `origin` at github.com/famyfa/ruledesk
- [x] Monorepo scaffold (npm workspaces, TypeScript, lint/test tooling)
- [x] `.gitignore`, `README.md`, `PROJECT.md`, `CLAUDE.md`
- [x] First commit + push

## 1. Discovery & planning (spec §15)
- [x] Architecture proposal — `docs/architecture.md`
- [x] OPNsense API compatibility matrix (verified against official docs) — `docs/api-compatibility.md`
- [x] Field mapping: OPNsense rule/alias ↔ domain model — `docs/field-mapping.md`
- [x] Threat model (credentials, sessions, privileged ops) — `docs/security.md`
- [x] Mock API specification — `docs/mock-api.md`
- [x] Executable acceptance tests for inline alias creation + rule editing
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
- [x] `apps/server`: Fastify backend, config from env, secrets never sent to browser
- [x] Authentication for the RuleDeck UI (session cookie, CSRF protection)
- [x] Firewall connection config (env-injected; no arbitrary URL fetching)
- [x] Read-only endpoints: rules, aliases, interfaces, selection options
- [x] Basic error handling + API error mapping (with tests)
- [x] Local dev environment (`npm run dev` runs mock + server + web)

## 3. Phase 2 — Spreadsheet rule editor (smallest working version)
- [x] `apps/web`: React + TS + Vite shell (sidebar, toolbar, grid area, details panel, drawer)
- [x] Dark/light theme, dense table styling, visible focus
- [x] Read-only rule grid in real firewall order (sticky header + id columns)
- [x] Filtering and search
- [x] Local working copy store (no writes to firewall)
- [x] Inline cell editing (click/Enter/Escape/Tab/Shift+Tab, arrow keys)
- [x] Modified / invalid / unchanged cell indicators
- [x] Undo / redo (with unit tests)
- [x] Rule cloning (placed after original, marked pending add)
- [x] Diff generation in admin-readable form (with unit tests)
- [x] Pending-changes count + diff preview drawer

## 4. Phase 3 — Alias-first workflow (signature feature)
- [x] Alias autocomplete in source/destination cells (shows object type)
- [x] "Create alias" inline popover (name, type, entries, description)
- [x] Alias validation (name, duplicates, malformed entries, pasted newline lists)
- [x] New alias immediately usable in the working copy
- [x] Edit alias inline without leaving the rule
- [x] Reference tracking; block deletion of referenced aliases unless acknowledged
- [x] Alias management page
- [x] Alias types discovered from API, not hard-coded

## 5. Phase 4 — Safe deployment
- [x] Validate all pending changes before apply
- [x] Concurrent-modification detection (conflict view: discard / reconcile / recreate)
- [x] Review screen: adds, modifies, deletes, reorders; lockout-risk warnings
- [x] Explicit confirmation before apply
- [x] Apply via verified API calls (writes → alias reconfigure → filter apply; 26.1 rollback timer not used yet)
- [x] Read back + verify result; staged vs written vs active states shown
- [x] Audit log (who, what, outcome; no secrets) in a small DB
- [x] Recovery guidance after partial failures
- [x] Rule reordering (drag-and-drop + keyboard), within supported groups only
- [x] Bulk editing (action, logging, enable/disable, description) with per-row validation

## 6. Phase 5 — Quality & packaging
- [x] E2E test: the full "add rule → inline alias → review → apply → reload" flow
- [ ] Docker Compose deployment (no cloud deps, not exposed publicly by default): Dockerfile + compose written and production mode tested without Docker; **image build not yet tested** (Docker engine wasn't running)
- [ ] Backup/restore of RuleDeck settings
- [ ] Encrypted credential storage with documented key strategy
- [x] Rate limiting on sensitive routes
- [ ] Version compatibility checks against real OPNsense instances
- [ ] Security review
- [ ] Usability polish
- [x] Docs: development.md, README updated
