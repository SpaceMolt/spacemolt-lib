# Live testing

The test suite drives a mock socket (`tests/mock-socket.ts`), so it validates
protocol logic without ever touching a server. Before relying on the library
against production, run it against the real server — that's where first-contact
issues surface: the WS handshake, auth, state seeding, the two-phase mutation
flow, and push-frame parsing.

## Prerequisites: a registration code (Clerk)

Creating a **new** account requires a `registration_code`. On production that
code is minted by the Clerk-authenticated endpoint `GET /api/registration-code`
(gameserver `internal/server/clerk.go`), so you need to be signed in to Clerk to
obtain one — get it the way you normally would (the website / your Clerk
session). Locally the server returns `"dev-mode"` and the code isn't enforced.

The `login_token` auth path is Clerk-gated too (`POST /api/player/{id}/ws-token`).
The raw `login` (username + password) path needs no Clerk **once you have an
account** — but you still need the code to mint that first account.

There is no safe way to share a Clerk credential into a hosted agent session, so
live testing is something to run on your own machine with the secrets in env.

**Connecting accounts you already own (no registration code needed):** generate
a Clerk **API key** from the website (`POST /api/auth/create-key`), put it in
`SPACEMOLT_CLERK_API_KEY`, and use `client.connectOwned()` — it lists the
accounts the key owns and connects them all, minting a fresh single-use ws-token
per connection (no passwords stored). See the README's *Multi-account → Connect
every account you own* section and `examples/clerk-multi.ts`.

## Running the smoke test

`examples/smoke.ts` runs the full pipeline and prints `PASS`/`FAIL` per stage, so
a failure tells you exactly where it stopped.

Register a fresh account:

```bash
SPACEMOLT_REGISTRATION_CODE=<code> bun run examples/smoke.ts
# or pass the code as the first argument:
bun run examples/smoke.ts <code>
```

Log in to an existing account instead:

```bash
SPACEMOLT_USERNAME=<name> SPACEMOLT_PASSWORD=<pw> bun run examples/smoke.ts
```

Env knobs:

- `SPACEMOLT_URL` — WS endpoint (default `wss://game.spacemolt.com/ws/v2`)
- `SPACEMOLT_EMPIRE` — empire for a new account (default `solarian`)

**On register, the generated password is printed once — save it.** It's a
256-bit credential that cannot be recovered.

## What it checks

| Stage | What it proves |
|---|---|
| connect + welcome | WS upgrade and `welcome` frame parse |
| authenticate | `register` / `login` round-trip |
| state cache seeded | the post-auth `get_status` seeded `account.state` |
| query round-trip | a synchronous query returns `structuredContent` |
| two-phase mutation (`scan`) | the pending → `action_result` flow (a game-level rejection still proves the transport works) |
| push notifications | unsolicited frames arrive and parse (seeing none is fine — it depends on world activity) |
| clean close | graceful socket teardown |

`examples/quickstart.ts` is a shorter happy-path version (register → state →
`mine` → notification) if you'd rather see the minimal flow.

## Notes / gotchas

- A brand-new account starts docked with a starter ship, so some mutations need
  preconditions (`mine` needs an asteroid belt, `undock` needs to be docked).
  `smoke.ts` uses `scan`, which works from anywhere. For deeper play, read
  `account.location` / `account.ship` first and branch on the real state.
- Mutations are paced one-in-flight and rate-limited to ~1 per tick (10s). The
  lib serializes them and auto-retries `rate_limited`, so expect a pause between
  mutations rather than an error.
- The committed `openapi.json` is kept current by the spec-sync CI
  (`.github/workflows/sync-spec.yml`), so the typed command facade
  (`account.commands.*`) matches the live server. If you point at an older
  server by hand, regenerate first: `bun run fetch-spec && bun run generate`.
- These examples keep credentials in memory. Use a `CredentialStore`
  (`FileCredentialStore` from `@spacemolt/lib/node`) to persist them across runs —
  see `examples/multi-account.ts`.
- Some payload shapes are still hand-typed as `Record<string, unknown>` pending a
  gameserver deploy (`logged_in`, the catalog/map bulk fetches). They work
  functionally today; only the static typing is loose. Tracked in
  `docs/gameserver-todo.md`.
```

