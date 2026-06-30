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
   - `src/generated/commands.gen.ts` — the ergonomic command facade: a typed
     param interface per action + a `Commands` interface grouped by tool, plus
     `buildCommands(dispatch)`. Backs `account.commands`.
   - `COMMANDS.md` (repo root) — a flat, greppable markdown reference of every
     command and its typed signature (query/mutation + params). This is the
     discovery surface for coding agents that don't drive a live LSP; it's
     generated from the same `ACTIONS` data, so it never drifts. Guarded by
     `tests/commands-doc.test.ts` (regenerate-and-compare).

Everything under `src/generated/`, plus the generated `COMMANDS.md`, is
auto-generated — **do not edit**. Re-run `bun run generate` after
`bun run fetch-spec`. The sync CI stages `COMMANDS.md` alongside the spec.

### Agent-facing docs

`AGENTS.md` and `llms.txt` (repo root, hand-written) orient an AI coding agent
*consuming* the published package: the calling pattern, how to discover commands
(grep `COMMANDS.md` / enumerate `ACTIONS`), and the typecheck-first loop (the
type system is the agent's substitute for IDE hints). All three ship in the npm
package (`package.json` `files`). These are distinct from this file, which is the
guide for working *on* the library.

### Spec-driven classification

Query vs mutation comes straight from the spec: operations carry
`x-is-mutation: true` when the command is queued for the next tick (the
two-phase `result` ack + later `action_result`). Absent/false means it
resolves synchronously. `scripts/generate.ts` reads this directly — do not
re-introduce a name-based heuristic.

### Spec sync (CI)

`.github/workflows/sync-spec.yml` keeps `openapi.json` + `src/generated/` in
lockstep with the live server automatically — this is what makes
"self-maintaining" real rather than a manual chore. On a schedule / manual
dispatch / `gameserver-deployed` repository_dispatch it runs `fetch-spec`, diffs
the result **normalized** (stripping `info.x-gameserver-version`, which the
server re-stamps on every deploy even when the API is unchanged), and on a real
change runs `generate` → `typecheck` → `test` and commits. A spec change that
breaks the hand-written layer fails the run instead of committing a broken sync.
Don't hand-run `fetch-spec`/`generate` to "catch up" — let the workflow do it;
run them locally only when iterating on the codegen itself.

The incremental gameserver-side work that backs this library is tracked in
[`docs/gameserver-todo.md`](docs/gameserver-todo.md) — push-frame schemas, auth
frame payloads, optional `x-state-sections`. Add to it whenever we hit a gap the
server is the right place to fix; open the PR only when a milestone needs it.

## Versioning & releases

**True semver, honest about breakage. `major` = a consumer's code breaks.** There
is no "0.x means unstable" hedge — we started at `1.0.0` and the major number is
*expected* to climb fast, because a self-maintaining lib whose command surface
tracks a live server breaks things regularly. A high major (we'll be in the
hundreds soon enough) is the honest stability signal: pin a version.

The bump level is computed programmatically — `scripts/classify-bump.ts` prints
`{ next, level, reasons }` as `max(catalog-diff, commit-signal)`:

- **Catalog diff** (deterministic): compares the generated command/notification
  surface at the last release tag against the current spec.
  - `major` — command/tool removed, param removed, a param made required, an
    enum value removed, a non-enum param type change, a query↔mutation kind flip
    (changes `await` semantics), a notification type removed.
  - `minor` — command/tool added, new optional param, new enum value, new
    notification type.
- **Commit signal**: conventional commits since the last tag for the hand-written
  layer the spec can't see — `feat!:`/`BREAKING CHANGE` → major, `feat:` → minor,
  `fix:`/`perf:` → patch, everything else → none.

`.github/workflows/release.yml` runs the classifier on every change to `main`
(PR merges via `push`; spec syncs via `workflow_run`, since the sync's
`GITHUB_TOKEN` commit doesn't fire a `push`), gates on typecheck + tests, then
bumps `package.json`, tags `vX.Y.Z`, and cuts a GitHub Release whose notes are
the classifier's reasons. The bump commit is pushed with `GITHUB_TOKEN`, which
does not re-trigger workflows — so there's no release loop. **No npm publish
yet** (consume from git/tags); wiring `npm publish` is a later step. Rules guarded
by `tests/classify-bump.test.ts`.

`GENERATED_SPEC_VERSION` (exported) records the gameserver spec version the
command surface was generated from, so a consumer can introspect which server
build their commands match independently of the lib's own version.

## Layout

```
.github/workflows/
  sync-spec.yml           CI: auto fetch-spec + generate + commit on spec change
AGENTS.md                 agent-facing orientation (hand-written; ships in pkg)
llms.txt                  agent-facing doc index (hand-written; ships in pkg)
COMMANDS.md               AUTO-GENERATED command reference (ships in pkg)
openapi.json              committed spec snapshot (synced via fetch-spec)
openapi-ts.config.ts      stage-1 codegen config
scripts/
  fetch-spec.ts           pull live spec
  generate.ts             stage-2 custom codegen
src/
  index.ts                public surface (browser-safe — no Node built-ins)
  node.ts                 Node/Bun-only entry (@spacemolt/lib/node)
  protocol.ts             hand-written WS v2 frame envelopes (stable layer)
  errors.ts               SpacemoltError / ConnectionClosedError
  client.ts               SpacemoltClient — multi-account manager (M4)
  account.ts              Account — one authenticated connection; pacing +
                          reconnect (M1/M4)
  transport/
    socket.ts             WS lifecycle over an injectable WebSocket
    correlator.ts         request_id ⇄ promise; two-phase mutation flow
  state/
    cache.ts              StateCache — 8-section cache, seed + applyDelta (M2)
    market.ts             MarketCache — subscribed order books (M3)
    observation.ts        ObservationCache — subscribed presence watch (M3)
  events/
    emitter.ts            TypedEmitter + EventStream async iterator (M3)
  auth/
    credentials.ts        CredentialStore iface + MemoryCredentialStore (M4)
    file-store.ts         FileCredentialStore (Node/Bun; imports node:fs) (M4)
  data/
    catalog.ts            CatalogCache — /api/catalog.json copy (M5)
    map.ts                MapCache — /api/map copy + httpBaseFromWs (M5)
  generated/              AUTO-GENERATED — do not edit
tests/
  mock-socket.ts          scriptable WebSocketLike for transport tests
```

## Milestones

- **M0 (done):** scaffold + self-maintaining codegen; protocol frame types.
- **M1 (done):** WS transport (`Account`) — connect/welcome/auth (raw creds),
  request_id correlation, query vs two-phase mutation, typed errors. Auth frames
  (`registered`/`logged_in`) are sequenced by frame type, not request_id, since
  the post-`register` `logged_in` is an unsolicited push. Driven in tests by an
  injected mock WebSocket (`tests/mock-socket.ts`).
- **M2 (done):** per-account state cache (`StateCache`). Seeded canonically via
  a `get_status` query after auth (its `structuredContent` is `V2GameState` —
  the same shape deltas patch), then kept current by applying the 8-section
  deltas from every `action_result`. `logged_in` has a *different* shape
  (`system`+`poi`, login extras) so it is not used to seed the section cache —
  it is exposed raw as `account.loginPayload`. `account.state` + section getters
  expose the cache; `onStateChange` reports changed sections.
- **M3 (done):** typed push-frame events + subscriptions. `account.on(type,cb)`
  (typed payload for published notification types), `onAny`, and async iterators
  `account.events(type)`/`anyEvents()` (buffered; `break` unsubscribes) over a
  `TypedEmitter`. `subscribeMarket`/`subscribeObservation` (+ unsubscribe) seed
  `MarketCache`/`ObservationCache` from the baseline snapshot; `market_update`/
  `observation_update` pushes merge automatically (internal handlers registered
  before user listeners). Read via `account.market(baseId)` / `observation()`.
- **M4 (done):** multi-account + resilience. `SpacemoltClient` manages N
  `Account`s, persisting credentials via a pluggable `CredentialStore`
  (`MemoryCredentialStore`, `FileCredentialStore`); `connectAll` staggers to
  respect login rate limits. Per-account pacing: `rate_limited` auto-retry
  (parses the interval; see gameserver-todo #4) and mutation serialization (one
  in flight at a time, matching the server's `action_pending`). Close-code-aware
  reconnect + re-auth + resubscribe (4001 `session_replaced` / 4002
  `auth_timeout` / deliberate `close()` are terminal; abnormal closes reconnect
  with backoff). Liveness watchdog deferred — a web-standard `WebSocket` can't
  observe the server's protocol-level pings, so an opt-in heartbeat query is the
  planned approach; today we rely on the socket `close` event.
- **M5 (done):** generated ergonomic command facade + bulk caches. A third
  codegen output (`commands.gen.ts`) emits a typed param interface per action
  and a `Commands` interface grouped by tool, plus `buildCommands(dispatch)`;
  `account.commands.spacemolt.jump({ id })` dispatches through `send` (so pacing
  + state cache apply). Param names come from the spec (`jump` takes `id`, not
  the doc's `target_system`). `CatalogCache`/`MapCache` (`src/data/`) fetch
  `/api/catalog.json` and `/api/map` over HTTP with id-keyed lookups;
  `client.catalog()`/`client.map()` fetch-once-and-cache.
- **M6 (done):** browser packaging + examples + docs. The main entry imports no
  Node built-ins; `FileCredentialStore` moved to a `@spacemolt/lib/node` subpath
  (`src/node.ts`) so the browser bundle stays clean — enforced by
  `tests/browser-safe.test.ts` and the `build:browser-check` script. `build`
  emits both entries (`dist/index.js` + `dist/node.js`) with `.d.ts`. Runnable
  `examples/` (typechecked) and a full README.

## Auth

**Clerk API key is the recommended path** for connecting accounts — especially
multi-account. Raw credentials remain for bootstrapping and single accounts:
`register` (returns a one-time generated password), `login` (username +
password), `login_token` (short-lived token from the Clerk-authenticated `POST
/api/player/{id}/ws-token`). Reach for stored passwords only as a fallback when
no Clerk key is available.

**Clerk multi-account** (`src/auth/clerk.ts`) — the first-class path:
authenticate with a Clerk **API key** (Bearer) to connect every account the
Clerk user owns without storing per-account passwords. `ClerkSource.listPlayers()`
reads `GET
/api/registration-code` (owned players); the `clerk` credential kind mints a
fresh single-use ws-token via `POST /api/player/{id}/ws-token` on each
(re)connect, then logs in with `login_token`. `client.connectOwned()` enumerates
and connects them all (staggered). The API key comes from an env var
(`SPACEMOLT_CLERK_API_KEY`); generate it from the website's `POST
/api/auth/create-key`. The token mint uses a separate per-user rate budget, so
it never competes with gameplay. Clerk *browser OAuth* (interactive sign-in) is
still a future seam — the API-key path is the headless/agent one.
