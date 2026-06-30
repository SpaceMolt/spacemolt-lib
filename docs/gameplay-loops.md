# Gameplay loops (reference implementations)

Common things a bot does, written against the library as-is — no helper layer.
Runnable, typechecked versions are in
[`examples/gameplay-loops.ts`](../examples/gameplay-loops.ts).

Two design rules these follow, because the real case is **many accounts each
running a loop concurrently**:

1. **The loop is silent.** It never prints. It returns a structured result and
   takes an optional typed `onProgress` callback. The caller — a fleet manager —
   owns rendering: route the callbacks into a per-account dashboard, or just read
   live state (`account.ship`, `account.cargo`, `account.location` are kept
   current locally) for any account whenever it paints. No stdout to grep.
2. **Lean on what the library already does:** mutation pacing (serialized +
   `rate_limited` auto-retried, so a plain `await` loop is safe) and local state
   (every awaited mutation applies the server delta before it resolves).

## 1. Mine until the cargo hold is full

`ship.cargo_used` / `cargo_capacity` are maintained locally, so "full" is a
comparison. Returns *why* it stopped and how much it mined; reports each step
through `onProgress`.

```ts
export interface MineResult { reason: 'full' | 'depleted' | 'no-yield' | 'aborted' | 'error'; mined: number; error?: Error }

async function mineUntilFull(
  account: Account,
  opts: { onProgress?: (p: { cargoUsed: number; cargoCapacity: number }) => void; signal?: AbortSignal } = {},
): Promise<MineResult> {
  const start = account.ship?.cargo_used ?? 0;
  const used = () => account.ship?.cargo_used ?? 0;
  const cap = () => account.ship?.cargo_capacity ?? 0;
  const finish = (reason: MineResult['reason'], error?: Error): MineResult => ({ reason, mined: used() - start, error });

  while (used() < cap()) {
    if (opts.signal?.aborted) return finish('aborted');
    if (!(account.location?.resources ?? []).some((r) => (r.remaining ?? 0) > 0)) return finish('depleted');
    const before = used();
    try {
      await account.commands.spacemolt.mine();
    } catch (err) {
      return finish('error', err as Error);
    }
    if (used() <= before) return finish('no-yield');
    opts.onProgress?.({ cargoUsed: used(), cargoCapacity: cap() });
  }
  return finish('full');
}
```

## 2. Jump to a distant (non-adjacent) system

`jump` moves one adjacent system at a time. `find_route` plans the hops and
estimates fuel. Note the return of `find_route` is **typed** — no cast (see
[Typed query results](#typed-query-results)).

```ts
async function jumpToSystem(
  account: Account,
  targetSystemId: string,
  opts: { onArrive?: (hop: { systemId: string; name: string; remaining: number }) => void } = {},
): Promise<{ arrivedAt: string; hops: number }> {
  if (account.location?.system_id === targetSystemId) return { arrivedAt: targetSystemId, hops: 0 };
  if (account.location?.docked_at) await account.commands.spacemolt.undock();

  const plan = (await account.commands.spacemolt.find_route({ id: targetSystemId })).structuredContent;
  if (!plan?.found) throw new Error(`no route: ${plan?.message}`);
  if (plan.estimated_fuel > plan.fuel_available) throw new Error('refuel first');

  let hops = 0;
  const total = plan.route.filter((h) => h.system_id !== account.location?.system_id).length;
  for (const hop of plan.route) {
    if (hop.system_id === account.location?.system_id) continue;
    await account.commands.spacemolt.jump({ id: hop.system_id }); // may take several ticks
    opts.onArrive?.({ systemId: hop.system_id, name: hop.name, remaining: total - ++hops });
  }
  return { arrivedAt: account.location?.system_id ?? targetSystemId, hops };
}
```

> A ship with a **Pathfinder Drive** can instead `jump` a numeric bearing toward
> distant coordinates directly — see `jump` in [`COMMANDS.md`](../COMMANDS.md).

## 3. Dock and load a specific item from storage

`withdraw` moves items from personal storage at the docked station into the cargo
hold (source defaults to personal storage → cargo; faction storage and named
buckets are available via the `source` / `bucket` params).

```ts
async function loadFromStorage(account: Account, itemId: string, quantity: number): Promise<{ itemId: string; held: number }> {
  if (!account.location?.docked_at) await account.commands.spacemolt.dock(); // must be at a station/base
  await account.commands.spacemolt_storage.withdraw({ item_id: itemId, quantity });
  const held = (account.cargo ?? []).find((c) => c.item_id === itemId)?.quantity ?? 0;
  return { itemId, held };
}
```

## Running these across a fleet

The loops stay silent, so a manager runs them concurrently and renders however it
likes — here, one line per account after they all settle. A live dashboard would
instead read `account.ship` / `account.location` (already local) on its own
cadence.

```ts
const accounts = await client.connectOwned();
const results = await Promise.allSettled(accounts.map((a) => mineUntilFull(a)));
// caller decides how to surface — nothing was printed inside the loop
```

## Typed query results

Every command is typed end to end:

- **Mutations** resolve to `MutationResult`, whose `delta` is the typed
  `V2GameState` patch (and the local cache is already updated).
- **Queries** resolve to `QueryResult<ResponseType>` — `structuredContent` is
  typed to that command's response, so there is **no cast**:

  ```ts
  const plan = (await account.commands.spacemolt.find_route({ id: 'sol' })).structuredContent;
  // plan: FindRouteResponse | undefined
  ```

`COMMANDS.md` shows each query's response type after `→`. The response type names
(and every game-object type) are re-exported from the package if you want to name
them explicitly:

```ts
import type { FindRouteResponse, V2GameState } from '@spacemolt/lib';
```

## Want these as built-in helpers?

These are shown as plain functions to demonstrate the library is usable without a
helper layer. If a `mineUntilFull` / `jumpToSystem` / `loadFromStorage`
convenience layer on `Account` would help, it's a small addition — ask.
