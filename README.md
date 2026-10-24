# RuleDeck

A spreadsheet-first, self-hosted UI for managing **OPNsense** firewall rules and aliases, inspired by Palo Alto Panorama.

Edit rules in one dense table, create aliases **inside the cell you're editing**, review a readable diff, and only then send anything to the firewall.

> **Status: early development.** Reading, editing, inline alias creation, diff and local staging work against a mock OPNsense. **Applying changes to a real firewall is not implemented yet** (Phase 4). See [PROJECT.md](PROJECT.md) and [TASKS.md](TASKS.md).

## Features so far

- Rule grid in real firewall evaluation order, with sticky headers and key columns, virtualized for large rule sets
- Spreadsheet keyboard model: arrows, Tab, Enter, Esc, typing to edit, copy/paste (including multi-cell TSV), Ctrl+Z/Ctrl+Y
- Address and port pickers with autocomplete over aliases, interfaces, well-known ports and literal addresses
- **Inline alias creation and editing** from a source/destination/port cell, with validation of pasted entry lists
- Clone, add, delete, drag-and-drop or Alt+↑/↓ reordering (only within the same OPNsense rule group)
- Bulk edit: action, enable/disable, logging, description prefix/suffix/replace
- Modified, new, invalid and read-only rows are labelled with text, not only color
- Everything is staged in a local working copy that survives reloads. Nothing is sent until you apply.
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

## Connecting a real OPNsense (read-only for now)

1. In OPNsense, create a dedicated user with an API key and only the privileges listed in [docs/security.md](docs/security.md).
2. Copy `.env.example` to `apps/server/.env` and fill in `OPNSENSE_URL`, `OPNSENSE_API_KEY`, `OPNSENSE_API_SECRET`.
3. Generate an admin password hash with `npm run hash-password` and put it in `RULEDECK_ADMIN_PASSWORD_HASH`.
4. If the firewall uses a self-signed certificate, export its CA and set `OPNSENSE_CA_FILE`. TLS verification can't be turned off.

**Don't point a development build at a production firewall.** Use a disposable test VM.

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
