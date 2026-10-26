# Changelog

## 1.0.0-rc.1 (2026-10-26)

First release candidate. Reads verified on OPNsense 26.7; writes on real firewalls are being tested.

**Rules and aliases**
- Rule table in evaluation order with content-sized columns; rule name first, click to edit
- Tabbed rule form (Panorama style) with inline alias creation
- Panorama-style filter expressions for rules, aliases and the log (CIDR and port ranges, alias expansion)
- Copy/paste, clone, reorder within rule groups, bulk edit, undo/redo
- Automatic rules read-only and hidden by default
- Apply with review, lockout warnings, conflict detection, changed-fields-only writes, activation and read-back

**Multi-site**
- Shared policy: create a rule or alias once, apply to all sites (per-site preview, canary order, stop at first failure, HA sync, drift)
- Sync rules, aliases and service entries to another site (staged there)
- Compare rules and aliases across sites

**Services**
- Kea DHCPv4/v6, Dnsmasq, Unbound, gateways, routes, VLANs, virtual IPs, syslog, cron (edit); NAT, WireGuard, users and groups (view)
- Certificate expiry across sites

**Operations**
- Live firewall log for one or all sites
- HA status and graceful switchover (CARP maintenance mode)
- OPNsense-style light and dark themes

**Security**
- Stateless server: sign in with your OPNsense account or an API key; nothing stored
- TLS always verified (CA or certificate pinning); secrets never reach the browser
- Security review with fixes; see docs/security.md

Open source under the MIT license.
