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

Open http://127.0.0.1:5173 and sign in with **admin / ruledeck-dev**. This starts three processes:

| Process | Address | Purpose |
|---|---|---|
| mock OPNsense | http://127.0.0.1:8443 | Fake firewall with seed rules and aliases |
| server | http://127.0.0.1:3000 | RuleDeck backend (holds the API credentials) |
| web | http://127.0.0.1:5173 | UI (Vite dev server, proxies `/api`) |

## Connecting a real OPNsense

1. In OPNsense, create a dedicated user with an API key and only the privileges listed in [docs/security.md](docs/security.md).
2. Copy `.env.example` to `apps/server/.env` and fill in `OPNSENSE_URL`, `OPNSENSE_API_KEY`, `OPNSENSE_API_SECRET`.
3. Generate an admin password hash with `npm run hash-password` and put it in `RULEDECK_ADMIN_PASSWORD_HASH`.
4. If the firewall uses a self-signed certificate, export its CA and set `OPNSENSE_CA_FILE`. TLS verification can't be turned off.

Writes stay disabled until you set `RULEDECK_ALLOW_WRITES=true`. **Test against a disposable OPNsense VM first, never a production firewall.**

## Running with Docker Compose

```sh
cp .env.example apps/server/.env      # fill it in (see above)
docker compose up -d --build
```

Open http://127.0.0.1:3000. The container serves the UI and API on one port, bound to localhost only, with a read-only filesystem and all capabilities dropped. Data (audit log) lives in the `ruledeck-data` volume. Keep the password hash in single quotes in the env file (`npm run hash-password` prints it that way) so the `$` signs aren't interpolated.

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
