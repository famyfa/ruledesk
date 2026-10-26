# RuleDeck

A self-hosted, Panorama-style management UI for **OPNsense**: firewall rules, aliases, services and HA for one or many sites, from one place.

Edit rules in a dense table and a tabbed form, create aliases while you write the rule, build a rule **once and apply it to every site**, review a readable diff, and only then send anything to the firewalls.

> **Status: release candidate (1.0.0-rc.1).** Everything is covered by tests against the bundled mock OPNsense, and reads were verified against real OPNsense 26.7 firewalls. Writes on real firewalls are being tested now. Writes are **off by default** (`RULEDECK_ALLOW_WRITES=false`). Try it on a lab or a disposable OPNsense first.
>
> RuleDeck started as a best-effort fix for one admin's daily pain. Use it, fork it, improve it. See [License](#license).

## What it does

**Firewall rules and aliases**
- Rule table in real evaluation order, content-sized columns, rule name first (click to edit), Panorama-style filter expressions: `( addr.src in 10.0.0.0/8 ) and ( action eq block )`, aliases are looked into
- Tabbed rule form; create an alias right from the source/destination/port field
- Copy/paste, clone, reorder (within OPNsense's rule groups), bulk edit, undo/redo; automatic rules are shown read-only (and hidden by default)
- Everything is staged locally. Apply = review screen, lockout warnings, conflict detection, only changed fields written, activation, read-back verification

**Many sites**
- **Shared policy:** create or edit a rule or alias once (with logical interfaces such as DMZ), then *Apply to all sites*: per-site preview, one site at a time, stops at the first failure, per-site result, optional HA sync. Drift view.
- **Sync** a rule, alias or service entry from one site to another (staged there for review)
- Compare rules and aliases across all sites

**Services** (site configuration)
- Edit: Kea DHCPv4/v6, Dnsmasq, Unbound DNS, gateways, static routes, VLANs, virtual IPs, syslog, cron. View: NAT, WireGuard, users and groups
- Certificate expiry across all sites
- Same safety model as rules; passwords and keys never reach the browser

**Operations**
- Live firewall log of one or all sites, with filter expressions and click-to-filter
- HA status per site and a graceful **switchover** (CARP maintenance mode) with checks and read-back
- Light and dark theme in OPNsense colors

**What it doesn't do:** store anything. No database, no credentials, no local users. You sign in with **your own OPNsense account** (local, LDAP, RADIUS, TOTP: whatever the firewall uses) or an API key, and every change shows up in the firewall's config history under your name. RuleDeck has no automatic rollback; the firewall's config history is the recovery.

## Install

See **[docs/install.md](docs/install.md)** (Docker Compose, reverse proxy, OPNsense users, topology file, first sign-in, upgrades, troubleshooting).

Short version:

```sh
git clone https://github.com/famyfa/ruledesk.git && cd ruledesk
cp .env.example apps/server/.env
cp ruledeck.topology.example.json ruledeck.topology.json   # list your firewalls
docker compose up -d --build
# open http://127.0.0.1:3000 and sign in with your OPNsense account
```

## Try it without a firewall

Requires Node.js 22.13 or newer.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173 and sign in with **admin / ruledeck-dev**. This starts two mock OPNsense firewalls (sites Berlin and Munich, each with a simulated HA peer), the server and the web app.

## Documentation

| | |
|---|---|
| [docs/install.md](docs/install.md) | Installing and running RuleDeck, OPNsense preparation, troubleshooting |
| [docs/multi-site.md](docs/multi-site.md) | Shared policy, sync, the interface map |
| [docs/services.md](docs/services.md) | Services: what is covered, how changes work, secrets |
| [docs/security.md](docs/security.md) | Threat model, privileges, security review |
| [docs/api-compatibility.md](docs/api-compatibility.md) | Every OPNsense endpoint used, verified in source and on live firewalls |
| [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md) | Working on the code |
| [CHANGELOG.md](CHANGELOG.md), [TASKS.md](TASKS.md) | What changed, what's next |

## Development

```sh
npm test             # unit + integration (Vitest, against the mock)
npx playwright test  # end-to-end on its own stack with the mock firewalls
npm run typecheck
```

Every OPNsense endpoint RuleDeck uses is verified against the OPNsense source for the target release and recorded in `docs/api-compatibility.md`; please keep it that way when adding features.

## License

[MIT](LICENSE). Use it, change it, share it, sell it, as long as the copyright notice stays in. It comes **without any warranty**: RuleDeck changes firewalls, so test it on something disposable first and keep OPNsense's config history at hand.

Contributions, issues and forks are welcome.
