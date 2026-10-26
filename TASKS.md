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
- [x] Apply via verified API calls (writes → alias reconfigure → filter apply; no automatic rollback by design)
- [x] Read back + verify result; staged vs written vs active states shown
- [x] Audit log (who, what, outcome; no secrets) in a small DB
- [x] Recovery guidance after partial failures
- [x] Rule reordering (drag-and-drop + keyboard), within supported groups only
- [x] Bulk editing (action, logging, enable/disable, description) with per-row validation

## 6. Phase 5 — Quality & packaging
- [x] E2E test: the full "add rule → inline alias → review → apply → reload" flow
- [ ] Docker Compose deployment (no cloud deps, not exposed publicly by default): Dockerfile + compose written and production mode tested without Docker; **image build not yet tested** (Docker engine wasn't running)
- [x] ~~Backup/restore of RuleDeck settings~~ (dropped: RuleDeck stores nothing)
- [x] ~~Encrypted credential storage~~ (dropped: no credentials are stored)
- [x] Rate limiting on sensitive routes
- [ ] Version compatibility checks against real OPNsense instances
- [ ] Security review
- [ ] Usability polish
- [x] Docs: development.md, README updated

## 7. Product decisions (2026-10-24)
- [x] No automatic rollback, ever. Recovery = OPNsense config history
- [x] RuleDeck stores nothing: no database, no stored credentials, no local admin
- [x] Sign in with OPNsense username + password (local/LDAP/RADIUS/TOTP decided by the firewall); API key as fallback
- [x] Non-secret topology file (sites, HA nodes, interface mapping) is OK
- [x] HA sync to the secondary: checkbox per apply
- [x] Shared objects marked with OPNsense category "RuleDeck shared"

## 8. Stateless sign-in (Phase 6)
- [x] Adversarial review (4 reviewers + 2 verifiers per finding): 19 confirmed findings fixed, with tests
- [x] Remove SQLite audit log, admin password, hash-password CLI, data dir
- [x] Topology file: sites, primary/secondary URLs, CA, interface map (zod, strict)
- [x] OPNsense GUI-session client: login form (username/password), session cookie + X-CSRFToken for API calls, logout
- [x] API-key auth kept as alternative per site
- [x] Mock: GUI login form + session/CSRF auth, per-user privileges, session timeout
- [x] Server sessions hold only per-site OPNsense sessions (memory), expiry + re-auth per site
- [x] Sign-in page: one card per site; per-site status; re-auth popover on expiry
- [x] Tests: login ok / wrong password / missing privilege / DNS-rebind error / expiry; no secrets in responses or logs
- [x] Docs: security model, operator guide for users/privileges

## 9. Multi-site shared policy (Phase 7)
- [x] Mock: multiple instances (2 sites x HA pair), upsert by uuid, categories, hasync
- [x] Client: upsert create by uuid, categories, hasync get/version/restart_all
- [x] Core: shared.ts (localize/canonicalize via interface map, label/kind guards, eligibility rules)
- [x] Core: buildSharedView + drift detection (missing, differs, unmarked, unmappable, order)
- [x] Core: projectToSite with slot-based ordering; new objects carry their final uuid (`new:<uuid>`)
- [x] Server: shared preflight (all sites, read-only) + sequential shared apply, stop on first failure
- [x] Server: HA role check, sync trigger, secondary verification
- [ ] UI: scope switcher (Shared / per site), shared rows locked in site view, share dialog
- [ ] UI: drift panel with resolutions, per-site review + acknowledgement, per-site result timeline, "Finish at site"
- [ ] E2E: build a rule once → applied at both sites with correct interface mapping → HA synced → no drift
- [ ] Docs: multi-site operator guide

## 10. UI rework (feedback 2026-10-25)
- [x] Table columns size to their content: min width = longest value in the column (no truncation), horizontal scroll for the rest
- [x] Replace inline cell editing with a Panorama/Palo Alto style rule editor: double-click (or Enter) on a row opens a form dialog with tabs (General, Source, Destination, Service/Port, Options/Advanced)
- [x] Keep inline alias creation inside the form's source/destination pickers ("Create alias" without leaving the form)
- [x] Same form style for aliases (alias editor dialog)
- [x] Grid stays for viewing, selecting, reordering, bulk edit, copy/paste; editing happens in the form
- [x] Feedback round 2: logging moved to the Advanced tab; alias picker = scrolling list + fixed "Create new alias" box; details side panel removed; Cancel in the rule form undoes everything done in it (including aliases created there); dropdowns no longer clipped by the dialog
- [x] Bug: automatic rules sharing one reference showed as pending "modifications" (unique ids for read-only rules; they never take part in change detection; regression tests incl. E2E)
- [x] Navigation like Panorama: top tabs (Dashboard, Policies, Objects, Sites, Changes, History, Settings), a left tree for tabs with sub-pages, pending/apply controls in the top bar, site switcher + undo/redo/refresh in a second row
- [x] Monitor tab: live firewall log of the primary (polling by digest, filters, pause/clear, rule links, forbidden/missed handling; mock endpoint, client, server route with rate limit, unit + E2E tests)
- [ ] Monitor: verify `diagnostics/firewall/log` against the live lab

## 11. Lab findings to finish (2026-10-25)
- [x] Record real OPNsense differences in docs/api-compatibility.md (get_rule defaults shape, firmware/info shape, unauthenticated API -> 302, TLS session resumption vs pinning)
- [x] Commit the work in progress (multi-site mock/client/server + certificate pinning + lab fixes) after fixing the 3 failing shared-apply tests

## 12. Filtering, sync and global views (feedback 2026-10-25)
- [x] Panorama-style filter expressions (and/or/not, eq/neq/contains/in/notin, CIDR and port-range matching, alias expansion, suggestions, help list, readable syntax errors) for the log, rules and aliases
- [x] Click a value in the log to filter on it (Shift+click excludes it)
- [x] Sync aliases / rules from one site to another: matched by name or description, interfaces translated, needed aliases brought along, categories stay local; staged as pending changes at the target (nothing sent)
- [x] Global monitor: log of all signed-in sites merged, with a Site column and a `site` filter
- [x] Global tab: rules and aliases of all sites side by side (same / differs / missing), filter, select and sync
- [x] Rule name (description) is the first column; clicking it opens the rule form
- [ ] Verify the sync and global views against the live lab (two HA sites)
- [ ] Docs: operator notes for sync vs. shared policy (docs/multi-site.md)

## 13. Graceful HA switch (new, 2026-10-25)
- [x] Research (source): CARP status = `get_vip_status`; `carp_status/{enable|disable|maintenance}`; maintenance is a TOGGLE (read before, read back after). Recorded in docs/api-compatibility.md
- [x] Confirmed live (read-only keys): `get_vip_status` (5 VIPs/site, all MASTER on node 1), `get_pfsync_nodes`, `firewall/log`; `trust/cert/search` reachable
- [x] Show HA state per site (role, CARP VIPs, maintenance, peer reachable over the sync link) in Sites; banner while the open site is in maintenance mode
- [x] "Switch over" / "Switch back" flow: checks -> one maintenance toggle (never repeated) -> read back until settled -> result with steps. RuleDeck sees only the node it is signed in to (peer = reachable over HA sync, not its own CARP state)
- [ ] Also read the peer node (second session or read-only key) to confirm it is MASTER after a switch
- [x] Config primary vs CARP master: RuleDeck keeps writing to the config primary (node A); a switchover moves only the VIPs. No change to apply needed
- [x] Mock: CARP state, maintenance toggle, takeover delay, stuck-backup; tests (core, server, routes, E2E)
- [ ] Live test in the lab (planned window, one site first)

## 14. Site configuration (new, 2026-10-25)
- [x] Scope: Kea DHCPv4/v6, Dnsmasq, Unbound, gateways, routes, VLANs, VIPs, syslog, cron (edit); NAT, WireGuard, users and groups (view); certificates (expiry overview)
- [x] Research per service in the 26.7 source; reads verified on the lab with read-only keys; recorded in docs/api-compatibility.md
- [x] Generic model: settings tree and tables as flat maps, option lists, secrets stripped on the server; stage -> review -> apply (conflict check, ordered writes, reconfigure, read-back); no automatic rollback
- [x] Services tab with a left tree by group; forms generated from the firewall's own model; changed fields marked; drafts kept in the tab
- [x] Certificates: whitelist (the firewall's list contains private keys), expiry per site, soonest first
- [x] Sync to another site (matched by natural key, choices translated by label, secrets never copied), staged at the target
- [x] Mock firewall implements the pattern; tests: core (flatten, change set, sync), server (apply, conflicts, partial, secrets), E2E
- [x] docs/services.md
- [ ] Live write test on the lab (one small change per service type, one site first): `add_*`, `set_*`, `del_*`, `reconfigure` are verified in source and by the mock only
- [ ] Compare a service across all sites in one view (like Global rules)
- [ ] Field labels and types from the OPNsense model XML instead of guessing (drop-down vs multi-select, numbers)
- [ ] More services: Monit, IDS, DHCP relay, router advertisements, traffic shaper, captive portal, OpenVPN, IPsec; NAT editing once its apply path is verified
- [ ] Certificates: create / import / renew / assign (private keys must never be stored or logged)

## 15. Release 1.0 (assessment 2026-10-26)
Must have
- [x] Global create/edit -> apply to all sites (Global ▸ Shared rules / Shared aliases / Apply to all sites / Drift; per-site preview, lockout acks, HA sync checkbox, canary order, stop at first failure, per-site result timeline; E2E incl. failure at site 1 and 2). Lab topology has the interface map. Still open: "share an existing rule" and a live test on the lab. Original goal: create a rule or alias once in the Global view, choose sites (default: all), review the per-site diff, one "Apply to all sites" (first site as canary, stop at the first failure, per-site result timeline, HA sync checkbox, "Finish at site"). Backend (shared policy, preflight/apply) exists; the UI does not (section 9 open items)
- [ ] Live write verification on the lab: rules apply, aliases, services (one per type), HA switch, shared apply; fix what the real firewalls show
- [x] LICENSE (MIT), CHANGELOG, version 1.0.0-rc.1 shown in Settings and /api/health, install/upgrade guide with reverse proxy examples (docs/install.md), README rewritten
- [x] Docker image built and run (2026-10-26): 321 MB, non-root, read-only + no capabilities, healthy; signed in with read-only API keys and read rules, log, HA state, a service and certificates from both lab sites through the container; writes refused when off; no secrets in responses; SIGTERM logs out of the firewalls (exit 0 in 1 s)
- [ ] Tag v1.0.0 after the live write test
- [ ] CI (GitHub Actions): typecheck, unit, E2E on the mock, image build, dependency audit
- [x] Security review (2026-10-26): 1 medium + 4 low findings fixed (secrets in browser drafts, response size cap, interface map before sign-in, headers/HSTS, logout on shutdown); results and residual risks in docs/security.md
- [x] Operator docs: docs/multi-site.md, docs/install.md (first steps, topology, settings, privileges, recovery, troubleshooting), docs/services.md, docs/security.md
Should have
- [ ] One place for all staged changes (rules, aliases, services, per site); sign-out warning counts all of them
- [ ] Read-only users: show what they can't do up front instead of errors; TOTP/LDAP sign-in checked on the lab
- [ ] Firewall versions: 25.7 and 26.1 compatibility checked or clearly marked unsupported
- [ ] Browser-side error reporting for expired sessions mid-apply; empty and first-run states; accessibility pass
Later
- [ ] Compare a service across all sites; field types from the OPNsense model files; more services; NAT editing; certificate create/import/renew

