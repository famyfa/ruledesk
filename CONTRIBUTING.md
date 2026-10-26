# Contributing to RuleDeck

Thanks for helping! RuleDeck is a small community project: issues, ideas, fixes and forks are all welcome.

## Branches

| Branch | Purpose |
|---|---|
| `main` | Releases. Always in a working state; tagged versions (`v1.0.0`, …) are cut from here |
| `dev` | Day-to-day development. Pull requests go here |

Work on a feature branch from `dev` (`feature/<short-name>` or `fix/<short-name>`), open a pull request into `dev`, and once a set of changes is tested, `dev` is merged into `main` for a release.

## Getting started

```sh
git clone https://github.com/famyfa/ruledesk.git
cd ruledesk
git checkout dev
npm install
npm run dev     # mock firewalls + server + web app; sign in as admin / ruledeck-dev
```

You don't need a real OPNsense: the mock imitates the API. Read [docs/architecture.md](docs/architecture.md) for how things fit together and [docs/development.md](docs/development.md) for commands and "how to add …" recipes.

## Before you open a pull request

```sh
npm run typecheck
npm test
npx playwright test
```

All three must pass (CI runs them too). Please also:

- add or update tests for what you changed (unit tests in `packages/core`, server tests against the mock, an E2E test for user-visible behavior);
- update the docs your change touches, and [CHANGELOG.md](CHANGELOG.md) under an "Unreleased" heading;
- keep the existing code style (Prettier-like formatting, 2-space indent, long lines are fine) and plain, short user-facing text.

## Ground rules

These keep RuleDeck safe to point at real firewalls:

1. **Never guess an OPNsense endpoint or payload.** Check the OPNsense source for the target release and record it in [docs/api-compatibility.md](docs/api-compatibility.md).
2. **RuleDeck stores nothing** on the server: no database, no credentials, no local users.
3. **No secrets** in responses, logs or browser storage.
4. **Only changed fields are written**; unknown fields must survive.
5. **Never claim a change is applied without reading it back.**
6. **No automatic rollback** (decided); recovery is OPNsense's config history.
7. Writes go only to the HA primary; one change per site at a time.

## Reporting bugs and ideas

Open an issue with what you did, what you expected and what happened, plus your OPNsense version. Leave out IP addresses, hostnames and anything secret. **Security problems:** please don't open a public issue; see [SECURITY.md](SECURITY.md).

## AI-assisted contributions

RuleDeck itself was largely written with an AI coding assistant. AI-assisted pull requests are fine, as long as you have read, run and tested the change yourself and can explain it. `CLAUDE.md` holds the project rules for AI assistants.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
