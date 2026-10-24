# Open API questions and compatibility risks

Each of these needs checking against a running OPNsense instance before write operations are enabled for that release.

## Open questions

1. **`search_rule` row shape.** Are all model fields present as flat strings in each row, or should RuleDeck call `get_rule` per rule for exact values? The plan is to use `search_rule` for the grid and `get_rule` before every write and for conflict checks.
2. **`rowCount: -1`.** Does it return all rows on both releases? The client pages defensively anyway (500 per page until `total` is reached).
3. **Legacy rule identity.** Do non-MVC rows have stable identifiers across reloads? They're read-only, but the grid needs stable row keys.
4. **`filter/apply` status string.** What does configd return on failure? The current assumption: anything other than a string starting with `OK` is treated as "not confirmed active".
5. **Read-back after apply.** Is there a reliable way to confirm a rule is *active* in pf (not just in config)? Candidate: `filter_util/rule_stats` contains the uuid after reload. This needs testing.
6. **Alias activation.** Is `alias/reconfigure` needed after alias CRUD when `filter/apply` also runs, or is `filter/apply` (which skips alias tables) enough? The current plan is to call `alias/reconfigure` whenever aliases changed.
7. **`set_rule` with partial body.** Confirm that fields left out are untouched (expected from `setNodes`).
8. **Validation keys.** Confirm the `rule.<field>` / `alias.<field>` keys for every field we map back to cells.
9. **Privilege names** for the minimal API user on each release.
10. **Sequence writes.** Confirm on a live instance that `set_rule` with only `sequence` reorders as expected on both releases (the source says yes).
11. **26.7 recovery.** With savepoint/rollback removed, is `core/backup/revert_backup` + `filter/apply` a safe documented recovery path? What happens to aliases?

## Compatibility risks

| Risk | Impact | Mitigation |
|---|---|---|
| Savepoint/rollback API removed in 26.7 | No automatic lockout protection on current stable | Lockout warnings on review screen. Config history recovery guide. Use rollback timer only when the flag is present |
| Model fields change between releases (e.g. `received-on` added in 26.7) | Unknown fields could be lost | Partial writes. `extra` preserves unknown fields. Clones copy all non-volatile fields |
| Reordering via `sequence` writes | If OPNsense ever recomputed sequences on save, order could differ | Minimal renumbering, a whole-group conflict check before writing, and read-back comparison of the final order |
| Alias rename refactors rules server-side | Our pending rule edits might reference the old name | Apply alias renames before rule writes, then rewrite pending references by name |
| Endpoint naming (`snake_case` vs `camelCase`) | 404s on some versions | Use snake_case, which current docs list. Map 404 to "unsupported endpoint" |
| Docs page shows GET for some POST-only endpoints | Wrong method returns `{status:"error"}` | Trust the source, not the docs table. Recorded in the matrix |
| Very large rule sets | Slow grid, slow conflict checks | Virtualized grid, paging, re-read only touched objects |
