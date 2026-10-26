# Services (site configuration)

RuleDeck manages more than firewall rules: DHCP, DNS, gateways, routes, VLANs, virtual IPs, syslog and cron jobs can be viewed, edited, compared with another site and applied. NAT, WireGuard, users and groups can be viewed. Certificates get an expiry overview across all sites.

Everything works through OPNsense's own API. Nothing is stored on the RuleDeck server.

## What is covered

| Service | Menu | Edit | Endpoints (26.7) |
|---|---|---|---|
| DHCPv4 (Kea) | Services ▸ DHCP & DNS | yes | `kea/dhcpv4/*` (settings, subnets, reservations, options, HA peers), `kea/service/reconfigure` |
| DHCPv6 (Kea) | | yes | `kea/dhcpv6/*` (plus PD pools) |
| Dnsmasq | | yes | `dnsmasq/settings/*` (hosts, domain overrides, ranges, tags, options, boot), `dnsmasq/service/reconfigure` |
| Unbound DNS | | yes | `unbound/settings/*` (host overrides and aliases, DNS-over-TLS, ACLs, blocklists), `unbound/service/reconfigure` |
| Gateways | Network | yes | `routing/settings/*_gateway`, `routing/settings/reconfigure` |
| Static routes | | yes | `routes/routes/*_route`, `routes/routes/reconfigure` |
| VLANs | | yes | `interfaces/vlan_settings/*_item`, `.../reconfigure` |
| Virtual IPs | | yes | `interfaces/vip_settings/*_item`, `.../reconfigure` |
| Syslog | System | yes | `syslog/settings/*` (settings, destinations), `syslog/service/reconfigure` |
| Cron jobs | | yes | `cron/settings/*_job`, `cron/service/reconfigure` |
| NAT | Firewall | view | `firewall/d_nat`, `source_nat`, `one_to_one`, `npt` (`search_rule`, `get_rule`) |
| WireGuard | Security | view | `wireguard/server`, `wireguard/client` |
| Users & groups | | view | `auth/user`, `auth/group` |
| Certificates | | view, expiry | `trust/cert/search`, `trust/ca/search` (whitelisted fields only) |

All of these were read in the OPNsense 26.7 controllers and their read side was checked on the lab firewalls. The write side (`add_*`, `set_*`, `del_*`, `reconfigure`) follows the standard OPNsense pattern and is covered by the mock; it has **not** been run on the lab yet (see TASKS.md).

## How a change works

1. **Stage:** edits are kept in your browser tab (like staged rules). Nothing is sent.
2. **Review:** a change list shows what will be created, changed or deleted.
3. **Apply:** RuleDeck re-reads the firewall and stops if anything you changed was changed there too. Then it writes the general settings, new entries, edits and deletions (stopping at the first refusal), activates the service (`reconfigure`) and reads everything back to compare.
4. **No automatic rollback.** If something goes wrong, restore the previous revision in OPNsense under System ▸ Configuration ▸ History. RuleDeck shows exactly which steps happened.

Only changed fields are sent.

## Sync to another site

"Sync to site…" copies chosen settings and entries to another signed-in site as **staged changes there**. Entries are matched by their natural key (host+domain, subnet, MAC address, gateway name, ...). Choice fields such as interfaces or linked subnets are translated by their label; an entry whose choice has no counterpart at the target is blocked and says why. Secrets are never copied.

## Secrets

Fields that look like secrets (password, secret, key, PSK, token, community, OTP seed, ...) never leave the server: they are empty in everything the browser gets, absent from logs and change lists, and shown as write-only inputs ("leave empty to keep"). A typed secret is written but cannot be read back, so the result says it was not verified.

The firewall's certificate list contains private keys. RuleDeck keeps only a fixed list of fields (name, subject, validity, usage) and drops everything else on the server.

## Limits

- The firewall's `get` answers carry no field types, so forms guess: a list of choices becomes a drop-down (a checkbox list for fields that allow several values, known per service), a 0/1 value a checkbox, anything else text. Field names are shown humanized. If a field is guessed wrong, the firewall's own validation reports it.
- Tables with more than 500 entries are not loaded.
- Read-only services (NAT, WireGuard, users and groups) change nothing; edit them in OPNsense.
- Certificates can be listed but not created, imported or renewed.
- The settings of Monit, Intrusion Detection, DHCP relay, router advertisements, traffic shaper and captive portal exist on the firewall but are not in the catalogue yet. Adding a service means adding one entry in `packages/core/src/service-catalog.ts`.
