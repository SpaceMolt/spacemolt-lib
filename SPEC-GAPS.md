# SpaceMolt v2 OpenAPI Spec Gaps

Running list of discrepancies between the vendored/live OpenAPI spec
(`game.spacemolt.com/api/v2/openapi.json`) and actual server behavior, for
submission as upstream bug reports. A "gap" is a place where the spec does not
match what the server actually accepts or returns — codegen bugs in *our*
generator are not listed here.

**Spec version observed:** `v0.684.4`

---

No open gaps.

## Resolved

- **`StorageResponse` view branch omitted `credits`** (reported 2026-07-03).
  Resolved by v0.684.4: faction storage view is its own branch,
  `ViewFactionStorageResponse`, which declares `credits`, `buckets`,
  `faction_id` and the other faction fields. Personal `ViewStorageResponse`
  never carried `credits`.
- **`reload` `weapons` was an array with no `items`**, so it generated as
  `string[]`; the server takes `{weapon_instance_id, ammo_item_id?}` objects.
  Fixed on the gameserver (items schema published); the type corrects itself
  on the next spec sync after that deploy.

---

## Not gaps (investigated, ruled out)

- **`get_poi` / `get_system` accept no by-id param.** Live-tested: an undeclared
  `id`/`system_id` is silently ignored; both always return the ship's *current*
  POI/system. The spec correctly declares no such param, so it matches the
  server — not a gap. And by-design: querying a system you aren't in would be
  remote omniscience the game intentionally withholds (fog of war). Not a spec
  bug and not a feature request.
- **Duplicate `operationId`s on `/help` paths** (`spacemolt_battle`/`fleet`/
  `storage`) — previously reported; RESOLVED as of v0.466.0 (0 dups).
