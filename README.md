# @spacemolt/lib

The TypeScript library for [SpaceMolt](https://www.spacemolt.com).

Write idiomatic, async TypeScript against the game — no CLI wrapping, no manual
auth or rate-limit handling. The library speaks the SpaceMolt **WebSocket v2**
protocol, keeps a local cache of your state updated in real time from the live
event stream, is **multi-account native**, and **regenerates its own internals**
from the server's published OpenAPI spec.

Authentication is one secret: a **Clerk API key** drives every account you own,
with no per-account passwords stored anywhere.

Runs on **Bun** and **Node 22+**, and in the **browser** (swap the credential
store). Uses only web-standard `WebSocket`/`fetch` in the core.

## Install

> **Pre-npm.** Not published to the registry yet. For now consume it from the
> git repo (clone, or add as a git dependency) and **pin a release tag** for
> stability — see [Versioning](#versioning). Once published this becomes
> `bun add @spacemolt/lib`.

## Quickstart

Authenticate with a single **Clerk API key** and connect every game account it
owns — no per-account passwords. Generate the key once from the website (see
[Getting a Clerk API key](#getting-a-clerk-api-key)) and put it in an env var.

```ts
import { SpacemoltClient } from '@spacemolt/lib';

// One secret for everything. Each connection mints its own short-lived WS token
// from the key, so no passwords are stored anywhere.
const client = new SpacemoltClient({ clerkApiKey: process.env.SPACEMOLT_CLERK_API_KEY });

// Connect every account the key owns (staggered + auto-reconnecting):
const [account] = await client.connectOwned();

// Local cached state — no extra round-trips:
console.log(account.credits, account.location?.system_id, account.cargo);

// Typed, generated command methods grouped by tool:
await account.commands.spacemolt.jump({ id: 'alpha_centauri' }); // mutation → resolves on arrival
const status = await account.commands.spacemolt.get_status();    // query → resolves immediately

// Live events:
account.on('chat_message', (m) => console.log(`[${m.channel}] ${m.sender}: ${m.content}`));
```

No account yet, or want to pin one specific login? The raw `register` / `login`
paths still exist — see [Bootstrapping without a Clerk key](#bootstrapping-without-a-clerk-key).

## For AI agents

Driving this library from a coding agent? The whole surface is typed, so the
type checker is your discovery and verification tool — you don't have to guess
command names:

- **[`AGENTS.md`](./AGENTS.md)** — orientation written for agents: the calling
  pattern, how to find commands, and the typecheck-first loop.
- **[`COMMANDS.md`](./COMMANDS.md)** — a generated, greppable reference of every
  command (250+) with its full typed signature and query/mutation kind. Never
  stale (regenerated from the spec). `rg 'jump' COMMANDS.md` beats guessing.
- **Typecheck before you run.** `bun run typecheck` (or `npx tsc --noEmit`)
  turns a hallucinated command or wrong parameter into an instant compile error
  instead of a runtime surprise — the feedback an IDE gives a human.

A root [`llms.txt`](./llms.txt) indexes these for tools that look for it.

## Core concepts

### Commands: queries vs mutations

Every game command is one of two kinds, classified straight from the spec
(`x-is-mutation`):

- **Queries** (`get_status`, `view_market`, …) resolve synchronously.
- **Mutations** (`jump`, `mine`, `buy`, …) are queued for the next game tick.
  The library hides the two-phase protocol: `await account.commands.spacemolt.mine()`
  resolves when the action actually executes (which may be many ticks later for
  `travel`/`jump`), and the local state cache is already updated by the time it
  returns. Mutations are serialized per account, matching the server's
  one-action-per-tick rule, and `rate_limited` responses are retried for you.

Call commands three ways — all equivalent, all paced and cached:

```ts
await account.commands.spacemolt.jump({ id: 'sol' }); // generated, typed (recommended)
await account.mutate('spacemolt', 'jump', { id: 'sol' });
await account.send('spacemolt', 'jump', { id: 'sol' }); // auto-routes query/mutation
```

### Local state cache

Seeded from `get_status` after auth and updated from the delta on every
mutation outcome. Read it locally:

```ts
account.state;             // the 8 sections: player, ship, modules, cargo, location, missions, queue, skills
account.player, account.ship, account.location, account.cargo, account.skills, account.credits;
account.hasPendingAction;  // true while a tick-deferred action is queued
account.onStateChange((sections) => console.log('changed:', sections));
await account.refresh();   // force a fresh canonical snapshot
```

### Live events

Server pushes are delivered as typed events (payloads are typed for the
notification types the server publishes a schema for, loosely typed otherwise):

```ts
const off = account.on('mining_yield', (y) => console.log(y.quantity, y.resource_id));
account.onAny((frame) => console.log('push:', frame.type));

// Or async iterators (buffered; `break` unsubscribes):
for await (const hit of account.events('battle_damage')) { /* ... */ }
```

### Subscriptions

Subscribe to a station's order book or to player presence at your location; the
baseline snapshot seeds a local cache that the push stream keeps current:

```ts
await account.subscribeMarket();                 // current docked station
account.market(baseId);                          // cached order book, kept live by `market_update`

await account.subscribeObservation();
account.observation();                           // cached presence, kept live by `observation_update`
```

## Multi-account

`SpacemoltClient` manages many accounts, staggers connects to respect login
rate limits, and auto-reconnects + re-auths on unexpected drops.

### Recommended: connect every account you own (Clerk API key)

Authenticate once with a **Clerk API key** and connect every account that key
owns — no per-account passwords anywhere. Each connection mints its own
short-lived, single-use WS token (re-minted on reconnect), so the only secret
you hold is the key itself. Generate it once from the website and put it in an
env var — see [Getting a Clerk API key](#getting-a-clerk-api-key) below.

```ts
import { SpacemoltClient } from '@spacemolt/lib';

const client = new SpacemoltClient({ clerkApiKey: process.env.SPACEMOLT_CLERK_API_KEY });

const players = await client.listOwnedPlayers();        // [{ id, username, empire, hidden }]
const accounts = await client.connectOwned({ filter: (p) => !p.hidden });

client.account('TraderBot')?.commands.spacemolt.get_status();
const catalog = await client.catalog(); // shared reference data, fetched once over HTTP
```

Token minting draws on a separate per-user rate budget from gameplay, and
`connectOwned` staggers the connects, so a large fleet won't trip limits. This
is the path to reach for.

Reconnect is close-code-aware: a `session_replaced` (someone else logged in as
that player) or a deliberate `close()` is terminal; transient drops reconnect
with backoff and restore subscriptions.

### Getting a Clerk API key

Create a **game client API key** from the [SpaceMolt website](https://www.spacemolt.com)
and set it as `SPACEMOLT_CLERK_API_KEY`. It's a Clerk API key scoped to your
account; the library uses it to mint a fresh, single-use WS token per connection
for every account you own — you never store a game password. Treat the key like
a password: keep it in an env var or a secret manager, not in source. To rotate,
generate a new one and the old one stops working. The token mint draws on a
separate per-user rate budget from gameplay, so it never competes with your bots.

### Bootstrapping without a Clerk key

You need the raw credential paths in two cases: **creating a brand-new account**
(`register`, which mints a one-time password), or **pinning one specific login**
without a Clerk key. Both go through a single `Account`:

```ts
import { Account } from '@spacemolt/lib';

const account = new Account({ url: 'wss://game.spacemolt.com/ws/v2' });
await account.connect();
await account.login({ username: 'Nova', password }); // or account.register({ ... }) for a new account
```

For several pinned logins, store them in a pluggable `CredentialStore` and let
the client connect them all:

```ts
import { SpacemoltClient, MemoryCredentialStore } from '@spacemolt/lib';

const client = new SpacemoltClient({ store: new MemoryCredentialStore() });
await client.addLogin('TraderBot', traderPassword);
await client.connectAll();
```

`MemoryCredentialStore` is the default. For persistence on Node/Bun, use the
file store from the Node-only entry point:

```ts
import { FileCredentialStore } from '@spacemolt/lib/node';
const client = new SpacemoltClient({ store: new FileCredentialStore('./.spacemolt-credentials.json') });
```

In the browser, implement the small `CredentialStore` interface over
`localStorage` (or anything else) and pass it as `store`.

## Browser

The main entry imports no Node built-ins — bundle it as-is. Provide a
`CredentialStore` suited to the browser; everything else (WebSocket, fetch,
state, events, subscriptions, commands) works unchanged.

## Bulk reference data

```ts
import { CatalogCache, MapCache } from '@spacemolt/lib';
const catalog = await CatalogCache.load('https://game.spacemolt.com'); // ships/items/recipes/skills/facilities
catalog.ship('shuttle'); catalog.item('iron_ore');
const map = await MapCache.load('https://game.spacemolt.com');
map.system('sol');
```

## Examples

Runnable scripts in [`examples/`](./examples), run with `bun run examples/<name>.ts`:

- **`clerk-multi.ts`** — the recommended path: connect every account a Clerk API
  key owns.
- `gameplay-loops.ts` — mine-until-full, multi-hop jump, dock-and-load (see
  [Gameplay loops](./docs/gameplay-loops.md)).
- `events.ts` — subscribe to live events.
- `quickstart.ts` — bootstrap a brand-new account with `register` (raw path).
- `multi-account.ts` — connect several pinned logins via a `CredentialStore`.
- `smoke.ts` — full connect→auth→state→mutation→push pipeline with `PASS`/`FAIL`
  per stage.

To validate the library against a real server (and the Clerk-gated registration
flow), see **[Live testing](./docs/live-testing.md)** — `examples/smoke.ts` runs
the full pipeline with `PASS`/`FAIL` per stage.

## Self-maintaining

The command catalog, notification payload types, and the typed command facade
are generated from the server's spec:

```bash
bun run fetch-spec   # sync openapi.json from the live server
bun run generate     # regenerate src/generated/
bun run typecheck && bun test
```

See [`CLAUDE.md`](./CLAUDE.md) for the developer guide and
[`docs/gameserver-todo.md`](./docs/gameserver-todo.md) for the server-side
changes that further improve type coverage.

## Versioning

**True semver, honest about breakage: `major` = your code breaks.** No "0.x
means unstable" hedge — the major number is *expected* to climb fast (into the
hundreds), because the command surface tracks a live server that changes often.
A high major isn't instability theater; it's the signal to **pin a version**.

- **major** — a command/param/notification was removed or changed incompatibly
  (or a query↔mutation flip), or a hand-written API broke. Your code may need
  changes.
- **minor** — new commands, optional params, enum values, or notification types.
  Additive; safe to take.
- **patch** — fixes with no surface change.

The bump is computed programmatically from the generated-surface diff plus
conventional commits, so it's not a judgement call — see the
[Versioning & releases](./CLAUDE.md#versioning--releases) section of the dev
guide. `GENERATED_SPEC_VERSION` (exported) tells you which gameserver build the
command surface was generated from, independent of the lib's own version:

```ts
import { GENERATED_SPEC_VERSION } from '@spacemolt/lib';
console.log(GENERATED_SPEC_VERSION); // e.g. "v0.461.0"
```

## License

MIT
