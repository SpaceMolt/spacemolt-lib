# Writing against @spacemolt/lib (for AI coding agents)

You are writing TypeScript that drives [SpaceMolt](https://www.spacemolt.com)
through `@spacemolt/lib`. This file is the orientation you need; it is short on
purpose. The library is **fully typed**, so the type checker is your best tool —
use it instead of guessing.

## The one rule: typecheck before you run

Every command, parameter, event, and state field is statically typed. **Run the
type checker before executing any script:**

```bash
bun run typecheck      # inside this repo
# or, in a consuming project:
npx tsc --noEmit
```

A hallucinated command (`account.commands.spacemolt.jmp`) or a wrong field is a
**compile error**, caught instantly — not a confusing runtime failure three
ticks later. This is the feedback loop a human gets from IDE squiggles; you get
it from `tsc`. Treat a clean typecheck as the gate before you run anything.

## How to find what exists

Do not guess command names. The full surface is enumerated for you:

- **[`COMMANDS.md`](./COMMANDS.md)** — every command (250+), grouped by tool,
  with its full typed signature, whether it's a query or a mutation, and a
  one-line description. Generated from the live server spec, so it is never
  stale. **Grep it** (`rg 'jump|travel' COMMANDS.md`) or read the tool section
  you need.
- **`ACTIONS`** (exported) — the same catalog at runtime, keyed by
  `"tool/action"`, if you'd rather enumerate in code:
  ```ts
  import { ACTIONS } from '@spacemolt/lib';
  console.log(Object.keys(ACTIONS));                 // every "tool/action"
  console.log(ACTIONS['spacemolt/jump']);            // { tool, action, kind, summary, params }
  ```
- The shipped **`.d.ts`** types back all of the above — if your editor/agent
  drives a language server, `account.commands.` autocompletes the whole tree.

## Connecting

The recommended path is a single **Clerk API key** that connects every account
it owns — no per-account passwords. Put the key in `SPACEMOLT_CLERK_API_KEY`
(generated from the website) and let `SpacemoltClient` do the rest:

```ts
import { SpacemoltClient } from '@spacemolt/lib';

const client = new SpacemoltClient({ clerkApiKey: process.env.SPACEMOLT_CLERK_API_KEY });
const [account] = await client.connectOwned();   // each connection mints its own WS token
```

For bootstrapping a brand-new account, or pinning one specific login without a
key, use a single `Account` with `register` / `login` instead (see the README).

## The calling pattern

Every command is a typed method on a connected `Account`, grouped by tool:

```ts
await account.commands.spacemolt.jump({ id: 'sol' });        // mutation
const status = await account.commands.spacemolt.get_status(); // query
```

- **Queries** resolve immediately with the server's `structuredContent`.
- **Mutations** queue for the next game tick; `await` resolves when the action
  actually executes (which may be several ticks later for `travel`/`jump`), with
  the local state cache already updated. Mutations are serialized one-in-flight
  per account and `rate_limited` retries are handled for you — expect a pause
  between mutations, not an error.

`COMMANDS.md` marks which kind each command is.

## Read state locally; react to events

State is cached locally (seeded after auth, updated from every mutation delta
and server push) — read it without a round-trip:

```ts
account.credits, account.ship, account.location, account.cargo, account.skills;
account.on('mining_yield', (y) => console.log(y.quantity, y.resource_id));
```

## Gotchas worth knowing up front

- **Preconditions are real.** A new account starts docked; `mine` needs an
  asteroid belt, `undock` needs to be docked. Read `account.location` /
  `account.ship` and branch on the real state rather than assuming.
- **Param names come from the server spec**, not intuition — `jump` takes `id`,
  not `target_system`. `COMMANDS.md` (and the types) are authoritative.
- **Don't hand-edit anything generated** (`src/generated/`, `COMMANDS.md`); it's
  regenerated from the spec.

For the full guide see [`README.md`](./README.md); for live-server testing see
[`docs/live-testing.md`](./docs/live-testing.md).
