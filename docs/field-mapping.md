# Field mapping: OPNsense ⇄ RuleDeck domain

The adapter lives in `packages/opnsense-client/src/adapter.ts`. Domain types live in `packages/core/src/domain.ts`.

## Raw record format

`search_rule` rows and `get_rule` responses are first flattened to `Record<string, string>`:

- Option maps `{key: {value, selected}}` become a comma-joined list of selected keys.
- Keys starting with `%` (display labels), `alias_meta_*` and `category_colors` are UI decorations. They are dropped.
- Rule stats (`evaluations`, `states`, `packets`, `bytes`, ... with `show_all`) are dropped.

## Firewall rule

| Domain field | OPNsense field | Conversion |
|---|---|---|
| `id` | `uuid` | as is |
| `origin` | `legacy` flag / missing uuid | `"mvc"` for model rules, `"legacy"` otherwise (read-only) |
| `enabled` | `enabled` | `"1"` ⇄ `true` |
| `action` | `action` | `pass \| block \| reject \| match` |
| `quick` | `quick` | `"1"` ⇄ `true` |
| `interfaces` | `interface` | comma list ⇄ `string[]`. Empty list means floating/any |
| `interfaceNot` | `interfacenot` | bool |
| `direction` | `direction` | `in \| out \| any` |
| `ipProtocol` | `ipprotocol` | `inet \| inet6 \| inet46` |
| `protocol` | `protocol` | e.g. `any`, `TCP`, `UDP`, `TCP/UDP`, `ICMP`. Kept as string |
| `source` | `source_net` + `source_not` | see Address below |
| `sourcePort` | `source_port` | see Port below |
| `destination` | `destination_net` + `destination_not` | see Address |
| `destinationPort` | `destination_port` | see Port |
| `description` | `description` | as is |
| `log` | `log` | bool |
| `categories` | `categories` | comma list of category uuids |
| `sequence` | `sequence` | integer (1–999999) |
| `position` | (derived) | index in `sort_order` order of the full list |
| `prioGroup` | `prio_group` | volatile, read only. Used to limit moves |
| `extra` | every other field | preserved verbatim, editable via the details panel |

Volatile fields (`sort_order`, `prio_group`) and `audit` are **never written**.

### Address (`source_net` / `destination_net`)

The field is multi-value (comma-separated) with a separate negate flag:

```ts
interface AddressSpec { negate: boolean; items: AddressItem[] }   // items = [] means "any"
type AddressItem =
  | { kind: "self" }                          // "(self)"
  | { kind: "interfaceNet"; iface: string }   // "lan"
  | { kind: "interfaceAddr"; iface: string }  // "lanip"
  | { kind: "alias"; name: string }           // alias name (OPNsense references aliases by NAME)
  | { kind: "literal"; value: string };       // IP, CIDR, range
```

Classification needs context (known interfaces and aliases):
`any` → empty items. `(self)` → self. A valid IP/CIDR/range → literal. A known interface key → interfaceNet. A known interface + `ip` → interfaceAddr. Anything else → alias. Aliases that are pending (staged locally) count as known.

Serialization joins `items` with `,`. Empty items serialize to `any`.

### Port (`source_port` / `destination_port`)

```ts
type PortSpec =
  | { kind: "any" }                     // ""
  | { kind: "literal"; value: string }  // "443", "8000-8080", "https" (well-known name)
  | { kind: "alias"; name: string };    // port alias name
```

## Alias

| Domain field | OPNsense field | Conversion |
|---|---|---|
| `id` | `uuid` | as is (local temp id `new:<n>` until created) |
| `name` | `name` | must match `^([a-zA-Z]\|(([_a-zA-Z][a-zA-Z0-9]\|[a-zA-Z][_a-zA-Z0-9])[_a-zA-Z0-9]{0,29}))$` and must not be a reserved pf keyword, service or protocol name |
| `type` | `type` | string. The option list is read from the firewall |
| `enabled` | `enabled` | bool |
| `entries` | `content` | newline-separated (`\n`) ⇄ `string[]` |
| `description` | `description` | as is |
| `categories` | `categories` | comma list |
| `extra` | `proto`, `interface`, `updatefreq`, `path_expression`, `authtype`, `expire`, ... | preserved verbatim |
| — | `current_items`, `last_updated`, counters, ... | volatile runtime data, read-only, never written |

## Fingerprints (conflict detection)

For each rule and alias in the baseline, RuleDeck stores a SHA-256 over its sorted, non-volatile raw fields. Before applying, the server re-reads every object the change set touches (and every rule in the affected `prio_group`s for moves) and compares fingerprints. A mismatch is a conflict. RuleDeck never overwrites in that case.
