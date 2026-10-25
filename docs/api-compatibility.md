# OPNsense API compatibility matrix

**Target release:** OPNsense **26.7.x** (current stable as of 2026-10; verified against tag `26.7.7`).
**Second release:** **26.1.x** (verified against tag `26.1.11`).

"Verified (source)" means checked against the OPNsense core source code at that tag. Nothing here has been verified against a running instance yet. That column will be filled in once integration tests run against a disposable test VM.

Base URL: `https://<host>/api/<module>/<controller>/<command>[/<param>...]`. Bodies are JSON. GET reads, POST writes.

**Authentication** (verified in source, `ApiControllerBase::beforeExecuteRoute`, 26.7.7):
- *GUI session (default in RuleDeck):* sign in through the login form at `/` (`authgui.inc`: hidden CSRF field, `usernamefld`, `passwordfld`, `login`; success = redirect plus regenerated `PHPSESSID`). API calls then send the cookie, plus `X-CSRFToken` on POST. No session gives 401, missing privilege 403, bad CSRF 403. A password-change requirement redirects to `/ui/user_portal`. Logout is `GET /index.php?logout`. The session timeout comes from the firewall (default 4 h). Changes are recorded in config history under the user.
- *API key (fallback):* HTTP Basic with key as username and secret as password.

## Version detection

| Endpoint | Response used | 26.7 | 26.1 | Live |
|---|---|---|---|---|
| `GET /api/core/firmware/info` | `product_id`, `product_version` (from `opnsense-version -nv`) | source | source | ☐ |

The server reads this at connect time and turns on feature flags (below). Unknown versions run in read-only mode until the user explicitly allows writes.

## Firewall rules (`firewall/filter`, model `Filter.xml`)

| Operation | Endpoint | Method | 26.7 | 26.1 | Live | Notes |
|---|---|---|---|---|---|---|
| List rules | `filter/search_rule` | GET/POST | source | source | ☐ | Query: `interface` (comma list; absent = all), `category`, `show_all`. Body: `current`, `rowCount`, `searchPhrase`, `sort`. Sorted by `sort_order`. **Also returns non-MVC (legacy + automatic) rules**, which carry a `legacy` flag |
| Get rule | `filter/get_rule/{uuid}` | GET | source | source | ☐ | Option fields come back as `{key: {value, selected}}` maps. No uuid returns defaults for a new rule |
| Add rule | `filter/add_rule` | POST | source | source | ☐ | Body `{"rule": {...}}` → `{"result":"saved","uuid":...}` or `{"result":"failed","validations":{"rule.<field>": msg}}` |
| Update rule | `filter/set_rule/{uuid}` | POST | source | source | ☐ | Body `{"rule": {...}}`. Only fields sent are changed. Full-model validation. No upsert of unknown uuid |
| Delete rule | `filter/del_rule/{uuid}` | POST | source | source | ☐ | `{"result":"deleted"}` or `"not found"` |
| Toggle enabled | `filter/toggle_rule/{uuid}/{0|1}` | POST | source | source | ☐ | |
| Toggle log | `filter/toggle_rule_log/{uuid}/{0|1}` | POST | source | source | ☐ | Doc page lists GET but the code requires POST |
| Move | `filter/move_rule_before/{selected}/{target}` | POST | source | source | ☐ | Fails unless both rules share `prio_group`. Rewrites `sequence` of moved (and possibly neighbouring) rules |
| Interfaces | `filter/get_interface_list` | GET | source | source | ☐ | Sections `floating`, `groups`, `interfaces`, `any` |
| Network options | `filter/list_network_select_options` | GET | source | source | ☐ | `any`, `(self)`, `<if>`, `<if>ip`, non-port aliases |
| Port options | `filter/list_port_select_options` | GET | source | **26.1+** | ☐ | Well-known ports + port aliases. Not in 25.7 |
| Activate | `filter/apply` | POST | source | source | ☐ | Runs `filter reload skip_alias`. Returns `{"status": "<configd output>"}` |

RuleDeck does **not** use automatic rollback (`filter/savepoint` etc., removed in 26.7 anyway). That's a deliberate decision.

## Aliases (`firewall/alias`, model `Alias.xml` v1.0.1 in 25.7–26.7)

| Operation | Endpoint | Method | 26.7 | 26.1 | Live | Notes |
|---|---|---|---|---|---|---|
| List | `alias/search_item` | GET/POST | source | source | ☐ | Query `type`, `category`. Sorted by name |
| Get | `alias/get_item/{uuid}` | GET | source | source | ☐ | `content` returned as option map that also includes all other alias names (unselected) |
| Add | `alias/add_item` | POST | source | source | ☐ | Body `{"alias": {...}}`. `content` is newline-separated |
| Update | `alias/set_item/{uuid}` | POST | source | source | ☐ | **Renaming refactors references in rules automatically** |
| Delete | `alias/del_item/{uuid}` | POST | source | source | ☐ | Throws "Alias in use" if referenced (`whereUsed`) |
| Toggle | `alias/toggle_item/{uuid}/{0|1}` | POST | source | source | ☐ | |
| Name → uuid | `alias/get_alias_u_u_i_d/{name}` | GET | source | source | ☐ | |
| Activate | `alias/reconfigure` | POST | source | source | ☐ | Reloads filter, alias template and tables |
| References | `alias_util/find_references` | POST | source | source | ☐ | Returns aliases containing an IP (runtime tables). Not rule references |
| Runtime table | `alias_util/list/{alias}` | GET | source | source | ☐ | **Runtime** pf table contents. Never treated as persistent config |

Alias types (from model): `host`, `network`, `port`, `url`, `urltable`, `urljson`, `geoip`, `networkgroup`, `mac`, `asn`, `dynipv6host`, `authgroup`, `internal`, `external`. RuleDeck should still read the option list from `get_item` (no uuid) at runtime rather than rely on this table.

## Config history (recovery)

| Operation | Endpoint | Method | 26.7 | 26.1 | Live |
|---|---|---|---|---|---|
| List backups | `core/backup/backups/{host}` | GET | source | source | ☐ |
| Diff | `core/backup/diff/{host}/{b1}/{b2}` | GET | source | source | ☐ |
| Revert | `core/backup/revert_backup/{backup}` | POST | source | source | ☐ |
| Download | `core/backup/download/{host}/{backup}` | GET | source | source | ☐ |

Every MVC save creates a new config history entry. That is RuleDeck's recovery mechanism on all versions.

## Monitoring (read-only)

| Operation | Endpoint | Method | 26.7 | Live | Notes |
|---|---|---|---|---|---|
| Firewall log | `diagnostics/firewall/log` | GET | source | ☐ | Query `limit` (0 = all), `digest`. Newest first; stops after `limit` rows or at the row whose `__digest__` matches (that row is included, RuleDeck cuts it off). Row fields: `__timestamp__`, `__host__`, `__digest__`, `action`, `dir`, `interface` (device name, e.g. vtnet1), `ipversion`, `protoname`, `src`, `dst`, `srcport`, `dstport`, `rid` (rule uuid or pf label), `label`. Needs the privilege for Firewall: Log Files: Live View |

RuleDeck only reads this log from the HA primary, never stores it, and keeps just a whitelist of fields.

## Feature flags by version

| Flag | 25.7 | 26.1 | 26.7 |
|---|---|---|---|
| `rules.read` | yes | yes | yes |
| `rules.write` | untested | yes | yes |
| `rules.portSelectOptions` | no | yes | yes |
| `rules.receivedOn` field | no | no | yes |
| `aliases.write` | untested | yes | yes |

## How RuleDeck writes (Phase 4)

| Step | Endpoint(s) | Notes |
|---|---|---|
| Conflict check | `search_rule`, `alias/search_item` | Fingerprints of touched objects plus the `(uuid, sequence)` list of every group being reordered must match the baseline |
| 1. Aliases | `alias/add_item`, `alias/set_item` | Changed fields only. Renames happen here, so OPNsense rewrites references |
| 2. Rules | `filter/add_rule`, `filter/set_rule` | Changed fields only, plus `sequence` when the order changes |
| 3. Deletes | `filter/del_rule`, then `alias/del_item` | Rules first, so aliases are no longer referenced |
| 4. Activate | `alias/reconfigure` (if aliases changed), `filter/apply` | Status must start with `OK` |
| 5. Verify | `search_rule`, `alias/search_item` | Every touched object and the order of reordered groups are compared |

**Ordering is written through the `sequence` field (`set_rule`), not `move_rule_before`.** Order is defined as `prio_group` + `sequence`, and `sequence` is a normal writable model field. Writing it directly is deterministic, idempotent and needs one call per moved rule. `move_rule_before` renumbers neighbours in ways that depend on gaps. RuleDeck keeps the longest already-ordered run of rules unchanged and only renumbers the rest (`planOrdering` in `packages/core/src/ordering.ts`).

There is no automatic rollback. Recovery relies on config history (every save creates a revision).

## Known limitations

- Legacy rules (Firewall ▸ Rules [legacy]) and automatic rules are read-only in RuleDeck.
- NAT (`d_nat`, `source_nat`, `one_to_one`, `npt`) is out of scope for the MVP.
- No ETag or config revision exists per object. Conflict detection compares fingerprints of re-read objects (see `field-mapping.md`).

## Findings from a live lab (2026-10-24/25)

Two OPNsense HA pairs, signed in with GUI username/password. These are the first checks against real firewalls; they differ from what the source alone suggested:

| Area | Expected (source) | Seen live | What RuleDeck does now |
|---|---|---|---|
| Unauthenticated API call | 401 | **302 redirect** to the login page | Any 3xx on an API call means "not signed in / session ended" |
| `core/firmware/info` | `product_id` + `product_version` at top level | Different shape (not as expected) | Version read from `product_version` or `product.product_version`, fallback `core/firmware/status`. If still unknown: sign in read-only with a note |
| `firewall/filter/get_rule` (defaults) | Every field is a string or an option map | Some fields have other shapes | Only the outer structure is validated; the protocol list is read tolerantly (option maps and option groups) |
| TLS | CA-signed or private CA | Self-signed certificate for `OPNsense.internal` on an IP address | Certificate pinning per node (`tlsFingerprint` in the topology). TLS session resumption is disabled for pinned connections, because a resumed session doesn't present the certificate |
| Login page | Hidden CSRF field + session cookie | As expected (22-char key) | — |

Shape errors now name the top-level fields that were received (never values), so further differences can be documented from the error text alone.

### Automatic and legacy rules (found live, 2026-10-25)

`filter/search_rule` also returns rules from `filter list non_mvc_rules` (anti-lockout, sshlockout, DHCP, RFC4890 ICMPv6, bogons, plugin rules). In these rows (source: `scripts/filter/list_non_mvc_rules.php`):

- `uuid` is the pf **label**, not a config uuid; `ref` is a reference that **many rules share**; `legacy` is true.
- They have no stable identity of their own. RuleDeck gives them ids `legacy:<label or ref>` and makes duplicates unique (`#2`, `#3`, ...) in listing order.
- They are read-only and **excluded from change detection**. (Using the shared `ref` as an id once made RuleDeck compare different rules with each other and report phantom modifications.)
