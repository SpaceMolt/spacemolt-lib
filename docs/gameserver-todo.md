# Gameserver-side TODO

Changes we need (or would benefit from) on the **gameserver** to make this
library cleaner and fully self-maintaining. Per the project's incremental
approach, we open these as gameserver PRs only when a library milestone
actually needs them — this file is the running backlog so nothing is lost.

**How to use this doc**
- Add an item the moment we hit a gap that the server is the right place to fix.
- Each item: status, the lib milestone that needs it, why, and where it lives
  in the gameserver (so the eventual PR is cheap to write).
- When an item ships, mark it `done` with the gameserver version that carries
  it, and note the corresponding lib change (usually: re-run `bun run generate`
  and delete a hand-maintained fallback).

Status legend: `todo` · `in-progress` · `blocked` · `done`

Baseline spec when this file started: gameserver **v0.452.0**.

---

## 1. Publish payload schemas for the untyped push frames
**Status:** done (live in v0.573.1) — but 8 frames remain · **Needed by:** M3 (typed push events) · **Priority:** medium

> **Update (2026-08-31):** Deployed and verified against the live spec: **39**
> `Notification_*` schemas are published, and every frame the list below named
> as missing now has one. The original scope is finished.
>
> Still untyped, so they degrade to `Record<string, unknown>` — these were never
> in the list above and are the remaining work:
> `server_restart_warning` (broadcast to every connected player; struct
> `protocol.ServerRestartWarningPayload` already exists — the highest-value one,
> since `seconds_until_restart` is what lets a fleet pause cleanly),
> `drone_adrift` (struct `protocol.DroneAdriftPayload` exists), and the six
> faction frames `faction_alliance_proposal`, `faction_alliance_formed`,
> `faction_alliance_broken`, `faction_war_declared`, `faction_peace_proposal`,
> `faction_peace_accepted` (five have `protocol.Faction*Notification` structs;
> `faction_peace_accepted` is a map literal and needs an inline description).
> Each is one `schemaForType(...)` line in
> `internal/openapi/notification_schemas.go`.

> **Update (2026-06-29):** Merged in gameserver PR #1563. Adds typed
> `Notification_<msg_type>` schemas for the 22 remaining push frames that fire
> today — 13 → **35** total. Struct-backed frames (battle_*, drone_update,
> drone_destroyed, base_raid_update, base_destroyed) reflect their
> `internal/protocol` structs; the map-literal emitters (drone_scan,
> drone_survey, facility_rent_warning, facility_reclaimed, trade_complete,
> trade_declined, trade_cancelled, player_kill, pirate_destroyed, pirate_radio,
> achievement_unlocked) are described inline from their verified emission sites,
> matching the existing chat_message/skill_level_up precedent (no Go struct, so
> nothing to reflect; no game-logic emit sites touched). `go test`, `go vet`,
> `golangci-lint` all clean.
>
> Pipeline verified: generating the v2 spec off that branch and running
> `bun run generate` here lifts `notifications.gen.ts` to 35 typed
> notifications and typechecks. **Lib follow-up once the server change is
> merged + deployed:** `bun run fetch-spec && bun run generate` — the new
> schemas flow into `notifications.gen.ts` automatically (no lib code change).
> Until then the committed `openapi.json` snapshot tracks deployed prod (13).

Only **13** push frames currently publish a `Notification_<msg_type>` schema in
`components.schemas` (chat_message, combat_update, crafting_update,
market_update, mining_yield, observation_update, pilotless_ship, player_died,
reconnected, scan_detected, scan_result, skill_level_up,
trade_offer_received). The library types push events off those schemas; every
other push frame falls back to `Record<string, unknown>`.

Frames that **fire today** but ship no schema (from `docs/websocket-v2.md` §6) —
these are the ones worth typing, in rough priority order:

- Combat/battle: `battle_started`, `battle_update`, `battle_damage`,
  `battle_joined`, `battle_left`, `battle_ended`, `battle_alert`
  (documented with field tables already — just need schemas emitted).
- Drones: `drone_update`, `drone_destroyed` (have field tables),
  `drone_scan`, `drone_survey` (untyped).
- Bases/facilities: `base_raid_update`, `base_destroyed` (have field tables),
  `facility_rent_warning`, `facility_reclaimed` (untyped).
- Trading: `trade_complete`, `trade_declined`, `trade_cancelled` (untyped).
- NPC/PvP: `player_kill`, `pirate_destroyed`, `pirate_radio` (untyped).
- Progression: `achievement_unlocked` (untyped).

**Where it lives:** `internal/openapi/notification_schemas.go`
(`NotificationPayloadSchemas()`), driven by the canonical structs in
`internal/protocol/messages.go`. Most of these already have a Go payload
struct; for those, adding a `schemaForType(&protocol.XPayload{})` line is
enough. The untyped ones (`player_kill`, `pirate_destroyed`, etc.) need their
payload struct defined first.

**Lib follow-up when done:** re-run `bun run generate`; the new `Notification_*`
schemas flow into `notifications.gen.ts` automatically (no lib code change).

---

## 2. Publish the auth/welcome frame payload schemas
**Status:** done (live in v0.573.1; consumed by the lib) · **Needed by:** M1–M2 · **Priority:** —

> **Update (2026-08-31):** Deployed and consumed. `WelcomeFrame`,
> `LoggedInFrame` and `RegisteredFrame` in `src/protocol.ts` now carry the
> generated `WelcomePayload` / `LoggedInPayload` / `RegisteredPayload` instead
> of hand-written mirrors, and the cast in `account.ts` is gone. No lib work
> left.

> **Update (2026-06-29):** Shipped server-side in gameserver PR #1566 (merged).
> `AuthFramePayloadSchemas()` (`internal/openapi/auth_schemas.go`) reflects
> `WelcomePayload` and `LoggedInPayload` into both specs' `components.schemas`.
> **Lib follow-up once deployed:** `bun run fetch-spec && bun run generate`,
> then replace the hand-written `LoggedInFrame.payload` (`Record<string,
> unknown>`) in `src/protocol.ts` with the generated `LoggedInPayload` type
> (and optionally swap the hand-typed welcome payload for `WelcomePayload`).

`V2GameState` **is** published (good — the action_result delta can ref it), but
the WS auth frames are not:

- `LoggedInPayload` — the `logged_in` frame body (player, ship, modules,
  system, poi, pending_trades, recent_chat, unread_chat). Needed by M2 to type
  the initial state seed from the spec instead of hand-maintaining it.
- `WelcomePayload` — the `welcome` frame body. Lower value (small, stable;
  already hand-typed in `src/protocol.ts`), but nice for consistency.

**Where it lives:** these structs are in `internal/protocol/messages.go`
(`LoggedInPayload`, welcome payload). Add them to the published v2 schema set in
`internal/openapi/` alongside the notification schemas.

**Lib follow-up when done:** replace the hand-written `LoggedInFrame.payload`
(`Record<string, unknown>`) in `src/protocol.ts` with the generated type.

---

## 3. (Optional) `x-state-sections` per mutation operation
**Status:** done server-side (live in v0.573.1); lib half still open · **Needed by:** M2/M3 · **Priority:** low

> **Update (2026-08-31):** Live — 122 operations carry `x-state-sections`, and
> `tests/generated.test.ts` already uses it to cross-check `STATE_SECTIONS`
> (that check is what caught the missing `prize_recoveries` section). **Still
> open:** surfacing it per command in the generated `ACTIONS` catalog as
> `stateSections?: StateSection[]` for optimistic UI / delta validation.
> Codegen-only; `scripts/generate.ts` already reads operation extensions.

> **Update (2026-06-29):** Shipped server-side in gameserver PR #1566 (merged).
> `v2.go` emits `x-state-sections: [...]` on every mutation operation (103 of
> them) alongside `x-is-mutation`, sourced from the registry's `StateSections`
> bitmask via a new `StateSections.SectionNames()`. Section names match the 8
> `V2GameState` keys exactly (player/ship/modules/cargo/location/missions/queue/
> skills). **Lib follow-up once deployed:** decide whether to surface this in
> the generated `ACTIONS` catalog (a `stateSections?: StateSection[]` field per
> mutation) for optimistic-UI / delta-validation; `scripts/generate.ts` reads
> the operation extensions, so it's a codegen-only change.

Each mutation handler declares a `StateSections` bitmask of which of the 8
delta sections it may touch (`internal/handlers/delta_wrapper.go`). Exposing
that per operation in the spec (e.g. `x-state-sections: ["ship","cargo"]`,
mirroring the existing `x-is-mutation`) would let the cache know what a command
can change before the `action_result` arrives — useful for optimistic UI and
for validating deltas. Not a blocker; revisit once the cache exists and we can
tell whether it earns its keep.

**Where it lives:** v2 spec generation in `internal/openapi/v2.go`, reading the
registry entry that already carries the bitmask
(`internal/commands/registry.go`).

---

## 4. Surface `retry_after` in the WS `rate_limited` error details
**Status:** done (live in v0.573.1) · **Needed by:** M4 · **Priority:** —

> **Update (2026-08-31):** Deployed — `internal/server/server.go` sets
> `details["retry_after"]`. `retryAfterMs` already prefers it, so the string
> parse is now a pure fallback. No lib work left.

> **Update (2026-06-29):** Shipped server-side in gameserver PR #1566 (merged).
> `rejectWSRateLimit` now sends `Decision.Details()` (limit/scope/limit_per_min/
> current) plus `retry_after` (seconds, int) in the error envelope's `details`,
> via a new `respondErrorWithDetails` helper. **Lib follow-up:** none required —
> `retryAfterMs` in `src/account.ts` already prefers `details.retry_after` when
> present, so once deployed the string parse becomes a pure fallback. No lib
> change needed.

The HTTP 429 body carries a structured `retry_after` (seconds), but the
WebSocket `rate_limited` error frame does not — `rejectWSRateLimit` →
`respondError` sends only `code` + `message`, and the retry interval is buried
in the message string ("…Retry in N seconds."). The library currently parses
the seconds out of the message (with a floor/default fallback). Adding
`retry_after` to the WS error `details` (the way `ResponseBody` does) would let
the client pace precisely without string-parsing.

**Where it lives:** `internal/server/server.go` `rejectWSRateLimit` /
`respondError`; the value is already on `ratelimit.Decision.RetryAfter`.

**Lib follow-up when done:** `retryAfterMs` in `src/account.ts` already prefers
`details.retry_after` when present — once the server sends it, the string parse
becomes a pure fallback.

---

## 5. Publish bulk-data + `registered` frame schemas (catalog, map, mobile base)
**Status:** done (live in v0.573.1); consumed except `MapData`, which is blocked on #9 · **Needed by:** M5 + auth · **Priority:** low

> **Update (2026-08-31):** Deployed. Consumed: `RegisteredPayload` in
> `src/protocol.ts`; `CatalogDump` now *derives* `Catalog` in
> `src/data/catalog.ts` (restating it by hand had silently dropped the
> `achievements`, `faction_achievements` and hidden-count sections — deriving it
> means the next added section breaks `typecheck` instead of vanishing);
> `MobileBaseLocation` via the new `src/data/mobile-base.ts`. `MapData` is
> **not** consumed and must not be — it documents the wrong element shape, see
> #9.

> **Update (2026-06-29):** Implemented server-side. A new `BulkDataSchemas()`
> (`internal/openapi/bulk_data_schemas.go`) reflects the three public bulk HTTP
> endpoint bodies and the last untyped auth frame into both specs'
> `components.schemas`, mirroring `AuthFramePayloadSchemas`:
>
> - `CatalogDump` — `GET /api/catalog.json` (version + ships/skills/recipes/
>   items/facilities). `items` stays `unknown[]` (the server merges Item|Module
>   into one `[]interface{}` list); everything else is fully typed.
> - `MapData` — `GET /api/map` (`systems` + `empires` id→colour map).
> - `MobileBaseLocation` — `GET /wheres-mobile-base` (the single moving
>   capital's current system id: `{ system }`).
> - `RegisteredPayload` — the `registered` WS frame (`{ password, player_id }`).
>
> Also fixed a latent codegen blocker: invopop emits `"items": true` (the
> JSON-Schema-2020 "any" form) for `[]interface{}` fields, which is invalid in
> OpenAPI 3.0 and **crashes** openapi-ts (`Cannot use 'in' operator … in true`).
> `schemaForType` now normalizes boolean `items` to an empty schema object,
> guarded by `TestSpec_NoBooleanArrayItems`. Verified end-to-end: regenerating
> the lib off the branch spec produces `CatalogDump`/`MapData`/
> `MobileBaseLocation`/`RegisteredPayload` types and typechecks.
>
> **Lib follow-up once deployed (one-time consumption, then self-maintaining):**
> replace the loosely-typed `CatalogEntry`/`MapSystem` (`[key: string]: unknown`)
> in `src/data/{catalog,map}.ts` with the generated section element types; add a
> small `MobileBaseLocation` fetch (the lib does not track it yet); type
> `RegisteredFrame.payload` from generated `RegisteredPayload`. After that the
> sync CI keeps them current with no edits.

---

## 7. Publish the station directory schemas (`GET /api/stations`)
**Status:** todo · **Needed by:** station bindings in `src/data/stations.ts` · **Priority:** low

`src/data/stations.ts` binds the public station directory with hand-written
types (`StationSummary`, `StationEmpire`) mirrored from the server's
`stationListEntry` (`internal/server/station_api.go`). Publish the list (and
ideally the `/api/stations/{id}` detail) response shapes through
`BulkDataSchemas()` (`internal/openapi/bulk_data_schemas.go`) the same way
`CatalogDump`/`MapData` are, then swap the hand-written types for the generated
ones so a server-side field change breaks `typecheck` instead of silently
drifting. Note `bulk_data_schemas.go` can't import `internal/server` (import
cycle), so the entry struct needs to move to a shared package (e.g.
`internal/apiresponses`) first.

## 6. Rate limit `login_token` per player instead of per IP
**Status:** done (live in v0.573.1) · **Needed by:** M4 (Clerk multi-account) · **Priority:** —

> **Update (2026-08-31):** Deployed — `CatClerkLoginToken` /
> `ClerkLoginTokenLimit` are in `internal/ratelimit/`. No lib work left.

> **Update (2026-07-02):** Shipped server-side. `login_token` (WS
> `spacemolt_auth/login_token` and HTTP v2 `POST /api/v2/spacemolt_auth/
> login_token`) previously shared the single per-IP `session_auth` bucket
> (30/min) with every other login/session-creation path, so a fleet of
> accounts connecting from one IP via `connectOwned()` competed for one
> shared budget and failed outright past ~30 accounts. Redemption is now
> checked against a new `clerk_login_token` bucket keyed on the token's
> target player ID (10/min per player, `internal/ratelimit`), so a large
> fleet connecting once each no longer competes with itself; a single
> account re-authenticating repeatedly (e.g. a bad harness re-logging in
> for every command) still trips its own limit quickly. Both handlers now
> look up the token's owning player non-destructively before the rate-limit
> check, so a rejected attempt doesn't burn the single-use token.
>
> **Lib follow-up:** `Account.authenticate()` now auto-retries on
> `rate_limited` the same way `query`/`mutate` already do — for `clerk`
> credentials each retry mints a fresh ws-token (the server change above
> means a rate-limited attempt no longer wastes the previous one either).
> Already implemented in this same change; no further lib work needed once
> the server change deploys. `connectStaggerMs` (default 250ms) is
> unchanged — the per-player budget alone is generous enough for normal
> fleet sizes without needing a longer stagger.

> **Update (2026-07-02, part 2):** The unrelated per-IP `connection` bucket
> (WS upgrade, was 20/min per IP) still applied to every new socket
> regardless of auth kind, defeating the point above for fleets over ~20
> accounts — and unlike `login_token`, this one can't be scoped per player:
> it's checked at the HTTP upgrade, before any credentials are read, so
> there's no identity to key on yet. It's also **not** something the lib's
> `authenticate()` retry helps with — a rejection here is an HTTP 429 on the
> WebSocket handshake itself, which surfaces to the lib as a generic
> `ConnectionClosedError` (`transport/socket.ts`), not a `SpacemoltError`
> with `code: 'rate_limited'`, so `withRateLimitRetry` never sees it. Fixed
> by raising the default `ConnLimit` from 20/min to 100/min
> (`internal/ratelimit/ip_limiter.go`) — generous enough that a fleet up to
> ~100 accounts completes within one window at the lib's default 250ms
> connect stagger, while real reconnect-thrashing abuse still accumulates
> rate-limit violations and gets IP-timed-out via the existing escalation
> path.
>
> **Lib follow-up (2026-07-02, part 3):** a fleet larger than ~100 accounts
> would still trip this — one fixed number always has a fleet size that
> exceeds it eventually, and repeatedly tripping a rate limit risks an
> IP-level timeout, not just a slower connect. `SpacemoltClient` now avoids
> asking in the first place instead of reacting after the fact:
> `connectAll`/`connectOwned` batch connects at `connectBatchSize` (default
> 100, matching `ConnLimit` above) and pause `connectBatchWaitMs` (default
> 65s, a margin over the server's 1-minute window) between batches, so a
> fleet of any size never actually exceeds the server's per-IP window. A
> fleet at or under 100 behaves exactly as before (one stagger pass, no
> pause). `connectRetry` (backoff on a failed handshake, added in part 2)
> stays as a fallback underneath the batching for the unexpected case — e.g.
> other traffic sharing the IP eating into the budget — rather than the
> primary defense.

**Where it lives:** `internal/ratelimit/decision.go` (`CatClerkLoginToken`),
`internal/ratelimit/ip_limiter.go` (`ClerkLoginTokenLimit`, default 10),
`internal/server/clerk.go` (`peekWSToken`, WS `handleLoginToken`),
`internal/httpapiv2/handlers.go` (HTTP v2 `handleLoginToken`).

---

## 8. `V2Location.docked_at` and `V2GameState.details` are mistyped in the spec
**Status:** done (gameserver PR #2145, live in v0.574.0) · **Priority:** —

> **Update (2026-08-31):** Fixed server-side and consumed here. `docked_at`
> publishes as `["string","null"]` (types now declare their nullable properties
> through a `NullableProperties()` method), and `details` carries `type: object`
> again. The lib's `StateDelta` takes `details` straight from `V2GameState`
> once more, and `docked_at` is cleared to `null` rather than `undefined`
> wherever the lib clears it, matching how the server reports undocked.

Two shapes the v0.573.x spec describes incorrectly. Both are cheap to fix and
both currently force a hand-written correction here.

**`V2Location.docked_at`** is published as a plain required `{"type": "string"}`,
but the Go field is `DockedAt *string` with no `omitempty` and its own
description says "Base ID docked at; **null** when undocked". So the server
really sends `"docked_at": null` on every undocked location while the spec
promises a string, and the generated type is `docked_at: string`. Any consumer
trusting the type gets `null` at runtime. It should be nullable (OpenAPI 3.0:
`{"type": "string", "nullable": true}`). Until then the lib's test fixtures use
`''` to stand in for "not docked".
**Where it lives:** `internal/handlers/v2state.go` (`V2Location.DockedAt`) —
the reflector needs a `jsonschema:"nullable"` hint or an explicit override.

**`V2GameState.details`** lost its `"type": "object"` between v0.547.0 and
v0.573.1 — it is now `{"description": "Action-specific detail data"}` with no
type at all, which generates as `unknown`. Every mutation's `delta.details` is
a JSON object, and `MutationResult<TDetails>` narrows it per command, so the
lib restores `Record<string, unknown>` by hand in `src/protocol.ts`. Restoring
`type: object` on the field would let that hand-written override go away.
**Where it lives:** `internal/handlers/v2state.go` (`V2GameState.Details`).

**Lib follow-up when done:** drop the `details` override in `src/protocol.ts`
and let `StateDelta` pick `details` straight from `V2GameState` again; drop the
`docked_at: ''` note in `tests/fixtures.ts`.

---

## 9. `MapData.systems` documents a shape `/api/map` never returns
**Status:** done (gameserver PR #2145, live in v0.574.0) · **Priority:** —

> **Update (2026-08-31):** Fixed server-side and consumed here. The bulk element
> is published as `MapDataSystem`, so it no longer collides with the v2 map
> command's `MapSystem`. `src/data/map.ts` now derives `MapSystem` and
> `GalaxyMap` from the generated `MapDataSystem`/`MapData` instead of the
> hand-written mirror, so a server-side field change breaks `typecheck` here.

`BulkDataSchemas()` publishes `MapData` for `GET /api/map`, whose Go element is
`game.MapSystem` (`internal/game/state.go`): `{id, name, x, y, online,
connections, empire?, empire_color?, is_home?, is_stronghold?, has_battle?,
battle_id?}`. But the component name `MapSystem` is already taken by the **v2
map command's** own entry type (`{system_id, visited, position: {x, y},
poi_count, ...}`), and that one wins in `components.schemas`. The published
`MapData.systems` therefore describes a shape the endpoint never returns —
different id field (`system_id` vs `id`), nested rather than flat coordinates.

Verified against the live endpoint: all 505 systems carry `id`, none carry
`system_id`. A client that trusted the spec here would index every system under
`undefined`.

Fix by giving one of them a distinct component name (e.g. reflect the bulk one
as `MapDataSystem`, or the v2 one as `DiscoveredMapSystem`) so both shapes can
coexist.
**Where it lives:** `internal/openapi/bulk_data_schemas.go` (`MapData`) vs
whichever v2 map command publishes `MapSystem`.

**Lib follow-up when done:** replace the hand-written `MapSystem` in
`src/data/map.ts` (currently mirrored from `game.MapSystem` and marked as
deliberately not spec-derived) with the generated element type.

---

## 10. Station directory drifted from the hand-written mirror
**Status:** todo · folded into #7 · **Priority:** low

While checking `src/data/stations.ts` against the live `GET /api/stations`,
three always-present fields were missing from the hand-written mirror:
`base_id`, `poi_id`, and `type` (76/76 entries carry each). `base_id` matters —
it is the identifier `location.docked_at` reports and base-scoped commands take,
so it is the join between the directory and live state, and it is *not* the
same as `id`. Added by hand for now.

This is the drift #7 predicts: a hand-written mirror rots silently because
nothing typechecks it against the server. Publishing `stationListEntry` through
`BulkDataSchemas()` (per #7) is the actual fix.

---

## 11. A delta cannot clear a pointer section, so `fleet board`/`disembark` are silent
**Status:** todo · **Needed by:** caching `riding`; correct ship state after boarding · **Priority:** medium

Boarding as a passenger parks your ship (`player.CurrentShipID = ""`,
`internal/handlers/fleet.go`) and `disembark` leaves you docked with no ship at
all. Neither transition can be expressed in a v2 delta today, so a client that
boards keeps serving a **stale ship** until something else triggers a full
`get_status`.

This is *not* the missing `StateSections` bitmask it looks like — adding one
does not help. The delta contract reads an absent section as "unchanged", and
`V2GameState.Ship` is a `*V2Ship` with `omitempty`, so a nil pointer is simply
omitted and "you no longer have a ship" is unsayable. The same applies to
`Riding` in reverse: it is only present *while* riding, so `disembark` cannot
signal that riding ended. Giving only `board` a section would leave the two
commands with asymmetric semantics, which is a worse trap than the current gap.

The server already solved this for slices: `modules`, `cargo` and
`prize_recoveries` use `omitzero` rather than `omitempty` precisely so an
explicit `[]` means "emptied" and an absent key means "untouched"
(`internal/handlers/v2state.go`). Pointer sections have no equivalent. The fix
is a convention that lets a delta serialize an explicit `null` for a *touched
but now-empty* pointer section, without every untouched delta emitting
`"ship": null` — e.g. a wrapper type with custom `MarshalJSON`, or `**V2Ship`
where the outer nil means untouched and the inner nil means cleared.

That changes the delta wire format for every client, so it wants its own PR and
its own risk review rather than riding along with a spec-correctness change.

**Lib follow-up when done:** add `riding` as a cached section (or a non-section
cached field), clear `ship`/`modules`/`cargo` when a delta clears them, and drop
the note in `GameState`'s doc comment telling callers to `refresh()` after
`fleet board`.

---

## Self-maintaining CI (the closing piece)

**Status:** done — `.github/workflows/sync-spec.yml`

The library now ships a spec-sync workflow (ported from client-v2's
`sync-spec.yml`): on a schedule / manual dispatch / `gameserver-deployed`
repository_dispatch it fetches the live v2 spec, diffs it **normalized**
(ignoring `info.x-gameserver-version`, which the server re-stamps every deploy),
and on a real change regenerates, typechecks, runs the tests, and commits the
result. This is the mechanism that makes "self-maintaining" automatic rather
than a manual chore — type/payload/tool/notification changes flow in on their
own; a spec change that breaks the hand-written layer fails the run instead of
landing broken.

The remaining hand-written payload shapes are deliberate, deploy-gated
**one-time consumption** steps (items #2 and #5 above): once the schemas are
live, wire the hand-written types to the generated ones and delete the
fallbacks. Consuming a generated type directly is also what locks the invariant
in — a future spec regression then breaks `typecheck` loudly instead of
silently rotting a hand-maintained shape.

---

## Done

_(items above are merged/implemented; lib consumption is gated on the
gameserver deploy)_
