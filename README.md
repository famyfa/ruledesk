# RuleDeck

A spreadsheet-first, self-hosted UI for managing **OPNsense** firewall rules and aliases, inspired by Palo Alto Panorama.

Edit rules in one dense table, create aliases **inside the cell you're editing**, review a readable diff, and only then send anything to the firewall.

> **Status: early development.** Everything works end to end against the bundled mock OPNsense, including apply with conflict detection and read-back verification. **It has not been tested against a real OPNsense yet**, so writes are disabled by default (`RULEDECK_ALLOW_WRITES=false`). See [PROJECT.md](PROJECT.md) and [TASKS.md](TASKS.md).

## Features so far

- Rule grid in real firewall evaluation order, with sticky headers and key columns, virtualized for large rule sets
- Spreadsheet keyboard model: arrows, Tab, Enter, Esc, typing to edit, copy/paste (including multi-cell TSV), Ctrl+Z/Ctrl+Y
- Address and port pickers with autocomplete over aliases, interfaces, well-known ports and literal addresses
- **Inline alias creation and editing** from a source/destination/port cell, with validation of pasted entry lists
- Clone, add, delete, drag-and-drop or Alt+↑/↓ reordering (only within the same OPNsense rule group)
- Bulk edit: action, enable/disable, logging, description prefix/suffix/replace
- Modified, new, invalid and read-only rows are labelled with text, not only color
- Everything is staged in a local working copy that survives reloads. Nothing is sent until you apply.
- Apply: review screen with lockout warnings, explicit confirmation, conflict detection against changes made elsewhere, writes of only the changed fields, activation, read-back verification, and recovery steps if anything fails
- Legacy and automatic rules are shown read-only. Unknown rule fields are preserved and editable in the details panel.
- Dark and light themes

## Quick start (development, with the mock firewall)

Requires Node.js 22.13 or newer.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173 and sign in with **admin / ruledeck-dev** (an account on the mock firewalls). This starts:

| Process | Address | Purpose |
|---|---|---|
| mock OPNsense ×2 | http://127.0.0.1:8443, :8444 | Two fake firewalls (sites Berlin and Munich) with seed rules and aliases |
| server | http://127.0.0.1:3000 | RuleDeck backend (holds the API credentials) |
| web | http://127.0.0.1:5173 | UI (Vite dev server, proxies `/api`) |

## Connecting real firewalls

RuleDeck stores nothing: no database, no credentials, no local users. You sign in with **your own OPNsense account** (local, LDAP, RADIUS, TOTP; whatever the firewall uses), or with an API key. Changes show up in each firewall's config history under your name.

1. Copy `ruledeck.topology.example.json` to `ruledeck.topology.json` and list your sites (the primary firewall URL, and the HA secondary if any). This file contains no secrets.
2. Copy `.env.example` to `apps/server/.env` and point `RULEDECK_TOPOLOGY_FILE` at the topology.
3. If a firewall uses a self-signed certificate, export its CA and set `caFile` for it in the topology. TLS verification can't be turned off.
4. Make sure your OPNsense users have the privileges listed in [docs/security.md](docs/security.md).

Writes stay disabled until you set `RULEDECK_ALLOW_WRITES=true`. **Test against a disposable OPNsense VM first, never a production firewall.**

## Running with Docker Compose

```sh
cp .env.example apps/server/.env
cp ruledeck.topology.example.json ruledeck.topology.json   # list your firewalls
docker compose up -d --build
```

Open http://127.0.0.1:3000 and sign in with your OPNsense account. The container serves the UI and API on one port, bound to localhost only, with a read-only filesystem, no volume and all capabilities dropped.

Browsers only send the session cookie over HTTPS or `http://localhost`. To use RuleDeck from another machine, put a TLS reverse proxy in front of it. Don't expose it to the internet.

## Tests

```sh
npm test            # unit + integration (Vitest, uses the mock)
npx playwright test # end-to-end (starts the dev stack if needed)
npm run typecheck
```

## Documentation

- [docs/architecture.md](docs/architecture.md): structure and key decisions
- [docs/api-compatibility.md](docs/api-compatibility.md): OPNsense endpoints by version
- [docs/field-mapping.md](docs/field-mapping.md): OPNsense ⇄ domain model
- [docs/security.md](docs/security.md): threat model and hardening
- [docs/mock-api.md](docs/mock-api.md): the mock firewall
- [docs/open-questions.md](docs/open-questions.md): unresolved API questions and risks
- [docs/development.md](docs/development.md): working on the code

## License

Not yet chosen.
