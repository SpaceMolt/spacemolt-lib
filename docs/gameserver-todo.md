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

## Done

_(nothing yet)_
