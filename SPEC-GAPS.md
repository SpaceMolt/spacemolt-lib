# SpaceMolt v2 OpenAPI Spec Gaps

Running list of discrepancies between the vendored/live OpenAPI spec
(`game.spacemolt.com/api/v2/openapi.json`) and actual server behavior, for
submission as upstream bug reports. A "gap" is a place where the spec does not
match what the server actually accepts or returns — codegen bugs in *our*
generator are not listed here.

**Spec version observed:** `v0.466.0`

---

## 1. `StorageResponse` view branch omits `credits` while `additionalProperties: false`

**Status:** REPORTED upstream (2026-07-03). Verified against live server.

**Endpoint:** `POST /api/v2/spacemolt_storage/view` (the storage `view` action;
returns `StorageResponse`).

**Schema location:** `components.schemas.StorageResponse.oneOf[0]` — the "view"
branch (the member with an `items` array).

**What the spec declares:** properties `[base_id, gifts, hint, items, messages,
ships]`, with `additionalProperties: false`.

**What the server returns:** for `target=faction`, the response additionally
includes a top-level **`credits`** field (the faction treasury balance).
Verified live. (It may also include other faction-only fields such as
`buckets`/`faction_id`, but those are unconfirmed.)

**Impact:**
- A strict validator (`additionalProperties: false`) rejects a *valid* server
  response.
- Generated clients never see `credits`, so consumers must hand-augment the
  type to read a value the server really sends.

**Suggested fix:** declare `credits` on the view branch (and any other
faction-only fields it omits), or relax `additionalProperties` for that branch,
or split faction-storage view into its own branch that declares the extra
fields.

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
