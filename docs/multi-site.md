# Multi-site: shared policy and sync

RuleDeck can manage several sites (each with an HA pair) and keep one set of rules and aliases the same everywhere.

There are two tools. Use the one that fits:

| | Shared policy (Global ▸ Shared …) | Sync (Rules / Aliases / Services ▸ "Sync to site…") |
|---|---|---|
| Idea | One set of rules and aliases that exists at every site, with the same identity | Copy something from one site to another once |
| After that | Edited once, applied to all sites together; drift is detected | The copies are independent |
| Marked on the firewall | Yes: category "RuleDeck shared" | No |
| Changes at the target | Applied directly with "Apply to all sites" | Staged at the target, reviewed and applied there |

## Shared policy

A rule or alias is **shared** when it carries the category **RuleDeck shared**. Shared objects have the *same uuid* on every site, so the firewalls themselves are the source of truth: RuleDeck stores nothing.

**Create once, apply everywhere**

1. Sign in to all sites (Sites tab).
2. Global ▸ **Shared rules** (or **Shared aliases**): create or edit exactly like normal rules. Interfaces are *logical* names (WAN, DMZ, …); each site maps them to its own interface (see below).
3. Click **Review & apply to all** (top right) or Global ▸ **Apply to all sites**.
4. Per site you see what will change, lockout warnings (acknowledge them per site) and a checkbox to synchronize the HA peer afterwards.
5. **Apply**: every site is re-read first. A conflict or problem at *any* site stops everything before anything is written. Then the sites are written **one at a time** in the order of the topology file. The first site that does not fully succeed stops the run; the remaining sites are not touched. Each site is read back and compared with what was intended.

There is **no automatic rollback**. If a later site fails, the sites before it keep the change. The result shows exactly which site has it and which does not; fix the cause and apply again (sites already up to date are skipped), or restore a site's previous revision in OPNsense (System ▸ Configuration ▸ History).

**Drift** (Global ▸ Drift) lists shared rules and aliases that differ between sites, sites whose interface map doesn't match the live firewall, and shared objects that exist only on some sites.

Rules that use things that mean something different per site cannot be shared: a gateway, a schedule, reply-to, shapers, "no XMLRPC sync". Aliases a shared rule uses must be shared too; types that depend on the firewall (e.g. dynamic IPv6 host, internal) cannot be shared.

Writes go only to the HA **primary** of each site. RuleDeck checks that the firewall has an HA sync target and refuses otherwise.

## The interface map (topology file)

Shared rules say "DMZ", not `opt3`. The operator's topology file maps each logical name to the real interface of each site, with the label pinned so a renamed or re-assigned interface is detected before anything is written:

```json
{
  "id": "ber",
  "name": "Berlin",
  "primary": { "url": "https://10.1.0.2" },
  "secondary": { "url": "https://10.1.0.3" },
  "interfaces": {
    "WAN": { "key": "wan",  "label": "WAN" },
    "DMZ": { "key": "opt1", "label": "DMZ" }
  }
}
```

- Either **every** site has an `interfaces` map or none does. Without maps there is no shared policy (sync still works).
- Every site must define the **same logical names** (UPPERCASE letters, digits, `_`).
- `key` is OPNsense's internal interface name (`wan`, `lan`, `opt1`, …); `label` is the name shown in OPNsense. Find both under Interfaces ▸ Assignments, or in the rule form's interface list. The keys can differ per site; that is the point.
- Before every write RuleDeck compares the map with the live firewall: a missing key or a different label blocks that site with a clear message.

## Sync

"Sync to site…" copies chosen rules, aliases, or service settings and entries to another signed-in site as **staged changes at the target**. Nothing is sent until you review and apply there. Rules and entries are matched by uuid or a natural key (description, host+domain, subnet, …); interfaces and other choices are translated by their label. Anything without a counterpart is blocked with the reason. Passwords and keys are never copied. See [services.md](services.md).

## Limits

- Existing rules are not shared until they carry the marker; there is no "share this rule" button yet (see TASKS.md). New rules created under Shared rules are shared from the start.
- All sites in the topology file must be signed in to apply (the run is all-or-nothing in the planning phase).
- Order of applying is the order of the sites in the topology file; the first site is effectively the canary.
