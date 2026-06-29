# SpaceMolt Lib — Developer Guide

## What this is

The definitive TypeScript library for SpaceMolt. Player-built clients and
scripts use it directly instead of shelling out to the CLI. Design pillars:

- **WebSocket v2 first.** All gameplay goes over `/ws/v2` (the `{tool, action,
  payload, request_id}` protocol). HTTP is used only for occasional bulk data
  fetches (`/api/catalog.json`, `/api/map*`, `/api/v2/openapi.json`).
- **Local state caches.** Per-account state is seeded from `logged_in` and
  updated from mutation deltas and server push frames, so reads are local and
  server bandwidth stays low.
- **Multi-account native.** One client manages N authenticated sockets.
- **Self-maintaining.** The command catalog and notification payload types are
  regenerated from the server's published OpenAPI spec — see Codegen below.

Targets **Bun** and **Node 22+** (both have global `WebSocket`/`fetch`).
The core is written to web-standard APIs only so the **browser** can be
supported by swapping the credential store; nothing in `src/` (outside
`src/auth/` file impls) may import Node built-ins.

Not a monorepo — this directory is its own git repo. `client-v2/` (the HTTP CLI)
and `gameserver/` are loaded only for reference.

## Commands

```bash
bun install
bun run fetch-spec    # sync openapi.json from the live server
bun run generate      # openapi-ts types + custom catalog/notification codegen
bun run typecheck     # tsc --noEmit
bun test              # run tests
bun run build         # bundle + emit .d.ts to dist/
```

## Codegen (self-maintaining internals)

`bun run generate` is two stages:

1. **`openapi-ts`** (`openapi-ts.config.ts`) → `src/generated/openapi/types.gen.ts`
   — raw TypeScript types for every schema in the spec, including the
   `Notification_*` push payloads and the core game objects.
2. **`scripts/generate.ts`** (custom) reads `openapi.json` and emits:
   - `src/generated/actions.gen.ts` — the tool/action command catalog
     (`ACTIONS`, `ToolName`, `ActionName`), with each command's params and a
     `query`/`mutation` classification.
   - `src/generated/notifications.gen.ts` — the `msg_type -> payload type` map
     (`NotificationPayloads`, `TypedNotificationType`) built from the
     `Notification_<msg_type>` schemas the server publishes.

Everything under `src/generated/` is auto-generated — **do not edit**. Re-run
`bun run generate` after `bun run fetch-spec`.

### Known generator heuristic

The spec does not yet flag which actions are mutations vs queries, so
`scripts/generate.ts` infers it from the action name (`get_`/`view_`/`scan`/…
are queries). Making this authoritative — e.g. an `x-mutation` /
`x-state-sections` extension per operation, and typed schemas for the push
frames that are still untyped (only 13 of ~50 carry a `Notification_*` schema
today) — is the incremental gameserver-side work that backs this library.
When the server publishes that metadata, replace the heuristic with the spec
value; don't grow the heuristic.

## Layout

```
openapi.json              committed spec snapshot (synced via fetch-spec)
openapi-ts.config.ts      stage-1 codegen config
scripts/
  fetch-spec.ts           pull live spec
  generate.ts             stage-2 custom codegen
src/
  index.ts                public surface
  protocol.ts             hand-written WS v2 frame envelopes (stable layer)
  generated/              AUTO-GENERATED — do not edit
  transport/ auth/ state/ events/   runtime client (built out across milestones)
tests/
```

## Milestones

- **M0 (done):** scaffold + self-maintaining codegen; protocol frame types.
- **M1:** WS transport — connect/welcome/auth (raw creds), request_id
  correlation, query vs two-phase mutation, typed errors.
- **M2:** per-account state cache from `logged_in` + deltas.
- **M3:** typed push-frame events / async iterators + market/observation subs.
- **M4:** multi-account manager, pluggable credential store, rate-limit pacing,
  reconnect + re-auth.
- **M5:** generated ergonomic action methods; bulk catalog/map caches.
- **M6:** browser packaging pass, examples, tests, docs.

## Auth

Raw credentials first: `register` (returns a one-time generated password),
`login` (username + password), `login_token` (short-lived token from the
Clerk-authenticated `POST /api/player/{id}/ws-token`). Clerk OAuth is a planned
later option for browser clients — leave the seam, don't build it yet.
