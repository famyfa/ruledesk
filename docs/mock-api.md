# Mock OPNsense API

`apps/mock-opnsense` is a small HTTP server that imitates the OPNsense endpoints RuleDeck uses. It is used for local development and automated tests. It does **not** try to be a complete OPNsense.

Default: `http://127.0.0.1:8443`, credentials `mock-key` / `mock-secret`.

## Implemented endpoints

The response shapes follow the 26.7 source (see `api-compatibility.md`).

| Endpoint | Behavior |
|---|---|
| `GET /api/core/firmware/info` | `{product_id:"opnsense", product_version:<configured>}` |
| `GET/POST /api/firewall/filter/search_rule` | Rules sorted by `sort_order`, filters `interface`, `searchPhrase`, paging `current`/`rowCount` (`-1` = all). Includes one legacy rule |
| `GET /api/firewall/filter/get_rule/{uuid}` | Option fields as `{key:{value,selected}}` |
| `POST /api/firewall/filter/add_rule` | Validates required/enum fields and alias references. Returns `saved` + uuid or `failed` + `validations` |
| `POST /api/firewall/filter/set_rule/{uuid}` | Partial update + validation |
| `POST /api/firewall/filter/del_rule/{uuid}` | `deleted` / `not found` |
| `POST /api/firewall/filter/toggle_rule/{uuid}/{0\|1}` | |
| `POST /api/firewall/filter/move_rule_before/{a}/{b}` | Rejects moves across `prio_group` |
| `GET /api/firewall/filter/get_interface_list` | |
| `GET /api/firewall/filter/list_network_select_options` | |
| `GET /api/firewall/filter/list_port_select_options` | |
| `POST /api/firewall/filter/apply` | Marks config active. `{status:"OK\n\n"}` |
| `GET/POST /api/firewall/alias/search_item` | |
| `GET /api/firewall/alias/get_item[/{uuid}]` | No uuid returns defaults, including the `type` option list |
| `POST /api/firewall/alias/add_item`, `set_item/{uuid}` | Name pattern + uniqueness + content validation. Renaming refactors rule references |
| `POST /api/firewall/alias/del_item/{uuid}` | 400-style error "Alias in use" when referenced |
| `POST /api/firewall/alias/reconfigure` | `{status:"ok"}` |

Unknown endpoints return HTTP 404 with `{"errorMessage":"Endpoint not found"}`, so RuleDeck's "unsupported endpoint" handling can be tested.

Requests without valid Basic auth get 401.

## Control endpoints (test only)

| Endpoint | Purpose |
|---|---|
| `POST /__mock/reset` | Restore seed data. Body may contain `{"version":"26.1.11"}` |
| `POST /__mock/faults` | Queue faults: `[{"match":"filter/set_rule","type":"validation"\|"timeout"\|"http500"\|"unsupported","count":1}]` |
| `POST /__mock/external-edit` | Simulate another admin changing a rule (for conflict tests) |
| `GET /__mock/state` | Dump state (rules, aliases, `dirty` flag) |

## Seed data

Interfaces `lan`, `wan`, `opt1` (DMZ). Aliases `RFC1918` (network), `WEB_PORTS` (port). Seven rules across interface and floating groups, one disabled, one with logging, plus one read-only legacy rule.
