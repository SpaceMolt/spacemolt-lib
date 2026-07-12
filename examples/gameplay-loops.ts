/**
 * Reference implementations for three common gameplay loops, written against the
 * library as-is (no helper layer).
 *
 *   SPACEMOLT_CLERK_API_KEY=<key> bun run examples/gameplay-loops.ts
 *
 * Designed for the real case: many accounts each running a loop concurrently. So
 * the loops are **silent** — they never print. Each returns a structured result,
 * and takes an optional typed `onProgress` callback. The caller (a fleet
 * manager) decides how to surface progress: route the callbacks into a per-account
 * dashboard, or just read live state (`account.ship`, `account.cargo`,
 * `account.location` are kept current locally) for any account whenever it
 * renders. No stdout to grep.
 *
 * What the library still handles for you: mutation pacing (serialized +
 * `rate_limited` auto-retried, so a plain `await` loop is safe) and local state
 * (every awaited mutation applies the server delta before it resolves).
 */

import { SpacemoltClient } from '../src/index.ts';
import type { Account } from '../src/index.ts';

// ---------------------------------------------------------------------------
// 1) Mine until the cargo hold is full.
// ---------------------------------------------------------------------------
export type MineStopReason = 'full' | 'depleted' | 'no-yield' | 'aborted' | 'error';

export interface MineResult {
  reason: MineStopReason;
  /** Cargo units gained over the run (cargo_used delta). */
  mined: number;
  error?: Error;
}

export interface MineOptions {
  /** Called after each successful mine with the live hold figures. */
  onProgress?: (p: { cargoUsed: number; cargoCapacity: number }) => void;
  /** Stop the loop early (fleet control). */
  signal?: AbortSignal;
}

/**
 * Mine until the hold is full. Preconditions: undocked, at a POI with mineable
 * resources. `ship.cargo_used` / `cargo_capacity` are maintained locally, so
 * "full" is a comparison — no need to sum the cargo array.
 */
export async function mineUntilFull(account: Account, opts: MineOptions = {}): Promise<MineResult> {
  const start = account.ship?.cargo_used ?? 0;
  const used = () => account.ship?.cargo_used ?? 0;
  const cap = () => account.ship?.cargo_capacity ?? 0;
  const finish = (reason: MineStopReason, error?: Error): MineResult => ({ reason, mined: used() - start, error });

  while (used() < cap()) {
    if (opts.signal?.aborted) return finish('aborted');
    if (!(account.location?.resources ?? []).some((r) => (r.remaining ?? 0) > 0)) return finish('depleted');

    const before = used();
    try {
      await account.commands.spacemolt.mine();
    } catch (error) {
      return finish('error', error instanceof Error ? error : new Error(String(error)));
    }
    if (used() <= before) return finish('no-yield'); // nothing fit / nothing here
    opts.onProgress?.({ cargoUsed: used(), cargoCapacity: cap() });
  }
  return finish('full');
}

// ---------------------------------------------------------------------------
// 2) Jump to a distant (non-adjacent) system.
// ---------------------------------------------------------------------------
export interface JumpResult {
  arrivedAt: string;
  hops: number;
}

export interface JumpOptions {
  /** Called on arrival at each intermediate system. */
  onArrive?: (hop: { systemId: string; name: string; remaining: number }) => void;
  signal?: AbortSignal;
}

/**
 * Jump to a distant system. `jump` only moves one adjacent system at a time, so
 * `find_route` plans the hops; we fuel-check, then jump each. Throws if there is
 * no route or not enough fuel (a fleet caller wraps this in `Promise.allSettled`).
 */
export async function jumpToSystem(
  account: Account,
  targetSystemId: string,
  opts: JumpOptions = {},
): Promise<JumpResult> {
  if (account.location?.system_id === targetSystemId) return { arrivedAt: targetSystemId, hops: 0 };
  if (account.location?.docked_at) await account.commands.spacemolt.undock();

  // `structuredContent` is typed FindRouteResponse — the facade returns
  // QueryResult<FindRouteResponse>, so no cast.
  const plan = (await account.commands.spacemolt.find_route({ id: targetSystemId })).structuredContent;

  if (!plan?.found) throw new Error(`no route to ${targetSystemId}: ${plan?.message ?? 'unknown'}`);
  if (plan.estimated_fuel > plan.fuel_available) {
    throw new Error(`route needs ${plan.estimated_fuel} fuel, have ${plan.fuel_available}`);
  }

  let hops = 0;
  const total = plan.route.filter((h) => h.system_id !== account.location?.system_id).length;
  for (const hop of plan.route) {
    if (hop.system_id === account.location?.system_id) continue; // skip origin
    if (opts.signal?.aborted) break;
    await account.commands.spacemolt.jump({ id: hop.system_id }); // resolves on arrival (may be several ticks)
    hops++;
    opts.onArrive?.({ systemId: hop.system_id, name: hop.name, remaining: total - hops });
  }
  return { arrivedAt: account.location?.system_id ?? targetSystemId, hops };
}

// ---------------------------------------------------------------------------
// 3) Dock and load a specific item from station storage into the cargo hold.
// ---------------------------------------------------------------------------
export interface LoadResult {
  itemId: string;
  /** Quantity of the item now in the cargo hold. */
  held: number;
}

/**
 * Dock (if needed) and withdraw an item from personal storage at the station
 * into the cargo hold. `withdraw` defaults source = personal storage → cargo;
 * faction storage / named buckets are available via the `source` / `bucket`
 * params. Throws (via the library) if there's nothing to withdraw.
 */
export async function loadFromStorage(account: Account, itemId: string, quantity: number): Promise<LoadResult> {
  if (!account.location?.docked_at) await account.commands.spacemolt.dock(); // requires a dockable POI
  await account.commands.spacemolt_storage.withdraw({ item_id: itemId, quantity });
  const held = (account.cargo ?? []).find((c) => c.item_id === itemId)?.quantity ?? 0;
  return { itemId, held };
}

// ---------------------------------------------------------------------------
// Fleet demo: run one loop across every owned account concurrently. The loops
// stay silent; this caller owns all rendering — here, a single compact summary
// line per account at the end. A real manager would read live `account.*` state
// (already local) to paint a live dashboard instead.
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const apiKey = process.env.SPACEMOLT_CLERK_API_KEY;
  if (!apiKey) {
    console.error('set SPACEMOLT_CLERK_API_KEY (see docs/live-testing.md)');
    process.exit(1);
  }
  const client = new SpacemoltClient({ url: process.env.SPACEMOLT_URL, clerkApiKey: apiKey });
  const players = await client.listOwnedPlayers();
  const accounts = await client.connectOwned();

  const label = (i: number) => players[i]?.username ?? accounts[i]?.player?.id ?? `acct-${i}`;

  const results = await Promise.allSettled(
    accounts.map((account) => mineUntilFull(account)), // silent; no interleaved logs
  );

  // The CALLER renders — one tidy line per account, keyed by name.
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const { reason, mined } = r.value;
      console.log(`${label(i)}: mined ${mined} units, stopped (${reason})`);
    } else {
      console.log(`${label(i)}: failed — ${r.reason}`);
    }
  });

  client.closeAll();
}
