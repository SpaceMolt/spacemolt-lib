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
**Status:** merged (gameserver PR #1563) · pending deploy · **Needed by:** M3 (typed push events) · **Priority:** high

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
**Status:** merged (gameserver PR #1566) · pending deploy · **Needed by:** M1–M2 · **Priority:** medium

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
**Status:** merged (gameserver PR #1566) · pending deploy · **Needed by:** M2/M3 · **Priority:** low

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
**Status:** merged (gameserver PR #1566) · pending deploy · **Needed by:** M4 (done, with a workaround) · **Priority:** low

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
**Status:** done (gameserver PR pending merge) · pending deploy · **Needed by:** M5 (bulk caches) + auth · **Priority:** medium

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

## 6. Rate limit `login_token` per player instead of per IP
**Status:** merged (gameserver branch `claude/spacemolt-clerk-ratelimit-frjp3a`) · pending deploy · **Needed by:** M4 (Clerk multi-account) · **Priority:** high

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

The unrelated per-IP `connection` bucket (WS upgrade, 20/min per IP) still
applies to every new socket regardless of auth kind — a fleet larger than
~20 accounts connecting within the same minute can still see a transient
`rate_limited` there before `login_token` is ever reached. The auth-retry
above covers that case too (it retries the whole `authenticate()` call, and
`SpacemoltClient.connect()` opens the socket immediately before it), though
a very large fleet's first batch may still trickle in over slightly more
than a minute. Not addressed here — flagged for a future item if it turns
out to matter in practice.

**Where it lives:** `internal/ratelimit/decision.go` (`CatClerkLoginToken`),
`internal/ratelimit/ip_limiter.go` (`ClerkLoginTokenLimit`, default 10),
`internal/server/clerk.go` (`peekWSToken`, WS `handleLoginToken`),
`internal/httpapiv2/handlers.go` (HTTP v2 `handleLoginToken`).

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
