/**
 * Market scouting — find out where to buy or sell something.
 *
 * **Remote markets are invisible.** `view_market` only ever shows the station
 * you are docked at, and there is no bulk price feed: `/api/stations` lists
 * every station and its services, but no prices. So "where can I buy a gas
 * harvester?" is not a lookup, it's a journey — you dock somewhere, look, and
 * write it down.
 *
 * That makes a price map an *asset*, not a query. This module tours a set of
 * stations, records what a watchlist costs at each, and hands back a structure
 * you can keep. (A faction with an intel terminal can share the same thing via
 * `submit_trade_intel` / `query_trade_intel`, which is the in-game version of
 * exactly this; without the facility you scout it yourself.)
 *
 * Plan the itinerary offline from the bulk endpoints — `/api/stations` gives
 * every station's `system_id`, `/api/map` gives system adjacency — then feed
 * the nearby station ids in here.
 */

import type { Account } from '../src/index.ts';
import { ensureDocked, ensureFuel, fuelState, marketHere, position, routeTo } from './loop-primitives.ts';

export interface MarketQuote {
  stationId: string;
  systemId?: string;
  itemId: string;
  /** What we would pay per unit here (0 = nothing for sale). */
  ask: number;
  askQty: number;
  /** What a buyer here pays us per unit (0 = no bids). */
  bid: number;
  bidQty: number;
}

export type ScoutReason = 'complete' | 'partial' | 'fuel-reserve' | 'aborted' | 'error';

export interface ScoutResult {
  reason: ScoutReason;
  visited: string[];
  unreachable: string[];
  quotes: MarketQuote[];
  error?: Error;
}

export interface ScoutOptions {
  onProgress?: (p: { step: string; detail?: string }) => void;
  signal?: AbortSignal;
  /** Head home below this fraction of tank. Default 0.25. */
  minFuelFraction?: number;
  /** Top up at every station that will sell fuel. Default true. */
  refuelEnRoute?: boolean;
}

/**
 * Dock at each station in turn and record prices for `watchlist`.
 *
 * Visits in the order given — callers who care about efficiency should sort by
 * distance first (the bulk map makes that cheap). Unreachable stations are
 * recorded rather than fatal: a scouting trip that covers four of six is still
 * four stations' worth of knowledge you didn't have.
 */
export async function scoutMarkets(
  account: Account,
  stationIds: readonly string[],
  watchlist: readonly string[],
  opts: ScoutOptions = {},
): Promise<ScoutResult> {
  const minFuel = opts.minFuelFraction ?? 0.25;
  const result: ScoutResult = { reason: 'complete', visited: [], unreachable: [], quotes: [] };

  try {
    for (const stationId of stationIds) {
      if (opts.signal?.aborted) return { ...result, reason: 'aborted' };
      if (fuelState(account).fraction < minFuel) {
        opts.onProgress?.({ step: 'low-fuel', detail: 'stopping the tour' });
        return { ...result, reason: 'partial' };
      }

      if (position(account).dockedAt !== stationId) {
        opts.onProgress?.({ step: 'travelling', detail: stationId });
        const route = await routeTo(account, stationId, { signal: opts.signal });
        if (route.reason === 'fuel-reserve') return { ...result, reason: 'fuel-reserve' };
        if (route.reason !== 'arrived') {
          opts.onProgress?.({ step: 'unreachable', detail: `${stationId}: ${route.reason}` });
          result.unreachable.push(stationId);
          continue;
        }
        await ensureDocked(account);
      }

      const rows = await marketHere(account);
      const systemId = position(account).systemId;
      for (const itemId of watchlist) {
        const row = rows.find((r) => r.item_id === itemId);
        result.quotes.push({
          stationId,
          systemId,
          itemId,
          ask: row?.best_sell ?? 0,
          askQty: row?.best_sell_qty ?? 0,
          bid: row?.best_buy ?? 0,
          bidQty: row?.best_buy_qty ?? 0,
        });
      }
      result.visited.push(stationId);
      opts.onProgress?.({ step: 'scouted', detail: `${stationId} (${systemId})` });

      if (opts.refuelEnRoute !== false) await ensureFuel(account, { min: 0.7 }).catch(() => undefined);
    }
    return result;
  } catch (error) {
    return { ...result, reason: 'error', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// ---------------------------------------------------------------------------
// Selectors (pure)
// ---------------------------------------------------------------------------

/** Cheapest place to buy `itemId`, ignoring stations with none for sale. */
export function cheapestSource(quotes: readonly MarketQuote[], itemId: string, quantity = 1): MarketQuote | undefined {
  return quotes
    .filter((q) => q.itemId === itemId && q.ask > 0 && q.askQty >= quantity)
    .sort((a, b) => a.ask - b.ask)[0];
}

/** Best place to sell `itemId`, ignoring stations with no bids. */
export function bestBuyer(quotes: readonly MarketQuote[], itemId: string, quantity = 1): MarketQuote | undefined {
  return quotes
    .filter((q) => q.itemId === itemId && q.bid > 0 && q.bidQty >= quantity)
    .sort((a, b) => b.bid - a.bid)[0];
}

/** Items on the watchlist that nobody visited had for sale. */
export function unavailable(quotes: readonly MarketQuote[], watchlist: readonly string[]): string[] {
  return watchlist.filter((itemId) => !quotes.some((q) => q.itemId === itemId && q.ask > 0));
}
