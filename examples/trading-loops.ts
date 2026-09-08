/**
 * Trader loops — the Exchange layer, plus the two money-making cycles the
 * Trader's Guide describes.
 *
 *   1. `runTradingMission`  — the mission frame: accept, satisfy, complete.
 *   2. `runArbitrageCycle`  — the one earning loop with no mission attached:
 *                             buy low here, haul, sell high there.
 *
 * Why missions come first: on a live station board, "Market Participation:
 * Selling" pays 1,000cr for moving 10 units of anything, while the same 10 units
 * of iron ore sell for ~2cr each. The guide's advice ("start with delivery
 * missions, add arbitrage later") is an order-of-magnitude claim, not a
 * stylistic one — so the mission loop is the primary earner and arbitrage is
 * the supplement.
 *
 * Silent by contract: no printing, structured returns, `onProgress` + `signal`.
 *
 *   SPACEMOLT_USERNAME=... SPACEMOLT_PASSWORD=... bun run examples/trading-loops.ts
 */

import { bestBid, bidDepth } from '../src/index.ts';
import type { Account } from '../src/index.ts';
import type { MarketListingItem, MissionInfo } from '../src/index.ts';
import {
  acceptMission,
  activeMissionId,
  board,
  ensureDocked,
  ensureFuel,
  ensureInCargo,
  heldQuantity,
  holdSpace,
  capabilities,
  isActive,
  marketHere,
  pickMission,
  routeTo,
  storageHere,
} from './loop-primitives.ts';

// ---------------------------------------------------------------------------
// Exchange primitives
// ---------------------------------------------------------------------------

export interface TradeResult {
  itemId: string;
  quantity: number;
  /** Credits received (sell) or paid (buy). */
  credits: number;
}

/** Sell from cargo into the station's best bids. Requires being docked. */
export async function sellHere(account: Account, itemId: string, quantity: number): Promise<TradeResult> {
  const res = (await account.commands.spacemolt.sell({ id: itemId, quantity })).delta?.details;
  return {
    itemId,
    quantity: res?.quantity_sold ?? 0,
    credits: res?.total_earned ?? 0,
  };
}

/** Buy into cargo (or storage) at the station's best asks. Requires being docked. */
export async function buyHere(
  account: Account,
  itemId: string,
  quantity: number,
  deliverTo: 'cargo' | 'storage' = 'cargo',
): Promise<TradeResult> {
  const res = (await account.commands.spacemolt.buy({ id: itemId, quantity, deliver_to: deliverTo })).delta?.details;
  return {
    itemId,
    quantity: res?.quantity ?? 0,
    credits: res?.total_cost ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Selectors (pure)
// ---------------------------------------------------------------------------

export interface Spread {
  itemId: string;
  itemName: string;
  /** What we'd pay per unit here. */
  ask: number;
  /** What the far market bids per unit. */
  bid: number;
  /** Units tradeable, limited by both books and the hold. */
  quantity: number;
  /** Expected gross profit for `quantity` units. */
  profit: number;
}

/**
 * Profitable buy-here/sell-there pairs, best first.
 *
 * Only counts items with a real ask here (`best_sell > 0`, i.e. something is
 * actually for sale) and a real bid there, and sizes each trade by the thinner
 * side of the two books so we don't plan a 500-unit trade into 7 units of
 * demand. `capacity` caps it again by what the hold can carry.
 */
export function findSpreads(
  here: readonly MarketListingItem[],
  there: readonly MarketListingItem[],
  { capacity = Number.POSITIVE_INFINITY, minProfit = 1 }: { capacity?: number; minProfit?: number } = {},
): Spread[] {
  const spreads: Spread[] = [];
  for (const row of here) {
    const ask = row.best_sell;
    if (ask <= 0) continue; // nothing offered for sale here
    const bid = bestBid(there, row.item_id);
    if (bid <= ask) continue; // no edge

    const quantity = Math.min(row.best_sell_qty, bidDepth(there, row.item_id), capacity);
    if (quantity <= 0) continue;

    const profit = (bid - ask) * quantity;
    if (profit < minProfit) continue;
    spreads.push({ itemId: row.item_id, itemName: row.item_name, ask, bid, quantity, profit });
  }
  return spreads.sort((a, b) => b.profit - a.profit);
}

/**
 * Anything in cargo that this station bids on, best proceeds first. Cargo rows
 * come off the wire with every field optional, so entries missing an id or
 * quantity are skipped rather than coerced.
 */
export function sellableHere(
  cargo: readonly { item_id?: string; quantity?: number }[],
  rows: readonly MarketListingItem[],
): { itemId: string; quantity: number; bid: number; proceeds: number }[] {
  return cargo
    .flatMap((c) => {
      if (!c.item_id || !c.quantity) return [];
      const bid = bestBid(rows, c.item_id);
      if (bid <= 0) return [];
      const quantity = Math.min(c.quantity, bidDepth(rows, c.item_id));
      if (quantity <= 0) return [];
      return [{ itemId: c.item_id, quantity, bid, proceeds: bid * quantity }];
    })
    .sort((a, b) => b.proceeds - a.proceeds);
}

/** Missions a trader can serve: market participation, delivery, and trade runs. */
export function isTradingMission(m: MissionInfo): boolean {
  const kinds = new Set(['sell_item', 'buy_item', 'deliver_item']);
  return (m.objectives ?? []).some((o) => kinds.has(o.type ?? ''));
}

// ---------------------------------------------------------------------------
// Loop 1 — the mission frame
// ---------------------------------------------------------------------------

export type TradingStopReason =
  | 'completed'
  | 'no-mission'
  | 'unsatisfiable'
  | 'no-route'
  | 'insufficient-fuel'
  /** Down to the last fuel cell — paused so a resupply can be planned. */
  | 'fuel-reserve'
  | 'aborted'
  | 'error';

export interface TradingMissionResult {
  reason: TradingStopReason;
  missionId?: string;
  title?: string;
  /** Reward credits, when the mission completed. */
  credits: number;
  error?: Error;
}

export interface TradingMissionOptions {
  onProgress?: (p: { step: string; detail?: string }) => void;
  signal?: AbortSignal;
  /** Narrow which missions to consider (default: any trading mission). */
  select?: (m: MissionInfo) => boolean;
}

/**
 * Accept the best trading mission on the local board and carry it out.
 *
 * Handles the three trading objective types:
 *   `buy_item`     — buy the quantity on the local exchange
 *   `sell_item`    — sell the quantity on the local exchange
 *   `deliver_item` — acquire the goods, haul them to the named base, dock
 *
 * `sell_item`/`buy_item` objectives are deliberately loose in the game data
 * ("sell 10 units of any item"), so they carry a quantity but no item_id; we
 * pick the cheapest thing that satisfies them.
 */
export async function runTradingMission(
  account: Account,
  opts: TradingMissionOptions = {},
): Promise<TradingMissionResult> {
  const finish = (reason: TradingStopReason, extra: Partial<TradingMissionResult> = {}): TradingMissionResult => ({
    reason,
    credits: 0,
    ...extra,
  });

  try {
    await ensureDocked(account);
    opts.onProgress?.({ step: 'reading-board' });

    const missions = await board(account);
    const pick = pickMission(missions, opts.select ?? isTradingMission, capabilities(account));
    if (!pick) return finish('no-mission');

    const { mission } = pick;

    if (!isActive(account, mission)) {
      opts.onProgress?.({ step: 'accepting', detail: mission.title });
      await acceptMission(account, mission);
    }

    // Accept by template id (or mission id for procedural missions), complete
    // by the per-instance mission id — for canned missions these are
    // different, and using the template returns `mission_not_found` only after
    // all the work is already done.
    const missionId = activeMissionId(account, mission);
    if (!missionId) return finish('unsatisfiable', { title: mission.title });

    for (const objective of mission.objectives ?? []) {
      if (opts.signal?.aborted) return finish('aborted', { missionId, title: mission.title });
      const outcome = await satisfyTradingObjective(account, objective, opts);
      if (outcome !== 'ok') return finish(outcome, { missionId, title: mission.title });
    }

    opts.onProgress?.({ step: 'completing', detail: mission.title });
    await ensureDocked(account);
    await account.commands.spacemolt.complete_mission({ id: missionId });

    return { reason: 'completed', missionId, title: mission.title, credits: mission.rewards?.credits ?? 0 };
  } catch (error) {
    return finish('error', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}

/** Dispatch one objective to the Exchange/Movement components that satisfy it. */
async function satisfyTradingObjective(
  account: Account,
  objective: NonNullable<MissionInfo['objectives']>[number],
  opts: TradingMissionOptions,
): Promise<'ok' | TradingStopReason> {
  const quantity = objective.quantity ?? 0;

  switch (objective.type) {
    case 'buy_item': {
      const itemId = objective.item_id ?? (await cheapestPurchase(account, quantity));
      if (!itemId) return 'unsatisfiable';
      opts.onProgress?.({ step: 'buying', detail: `${quantity} x ${itemId}` });
      await buyHere(account, itemId, quantity);
      return 'ok';
    }

    case 'sell_item': {
      const itemId = objective.item_id ?? (await mostSellableHolding(account, quantity));
      if (!itemId) return 'unsatisfiable';
      // Goods accumulate in station storage; sell reads cargo.
      const available = await ensureInCargo(account, itemId, quantity);
      if (available < quantity) return 'unsatisfiable';
      opts.onProgress?.({ step: 'selling', detail: `${quantity} x ${itemId}` });
      await sellHere(account, itemId, quantity);
      return 'ok';
    }

    case 'deliver_item': {
      const itemId = objective.item_id;
      const target = objective.target_base_id;
      if (!itemId || !target) return 'unsatisfiable';

      const shortfall = quantity - heldQuantity(account, itemId);
      if (shortfall > 0) {
        opts.onProgress?.({ step: 'sourcing', detail: `${shortfall} x ${itemId}` });
        const bought = await buyHere(account, itemId, shortfall);
        if (bought.quantity < shortfall) return 'unsatisfiable';
      }

      await ensureFuel(account, { min: 0.5 });
      opts.onProgress?.({ step: 'hauling', detail: target });
      const route = await routeTo(account, target, { signal: opts.signal });
      if (route.reason !== 'arrived') return route.reason === 'aborted' ? 'aborted' : route.reason;
      await ensureDocked(account);
      return 'ok';
    }

    // Objectives outside the trading vocabulary (visit_system, dock_at_base)
    // ride along on some trade-run missions; treat them as movement.
    case 'visit_system':
    case 'dock_at_base': {
      const target = objective.target_base_id ?? objective.system_id;
      if (!target) return 'unsatisfiable';
      await ensureFuel(account, { min: 0.5 });
      const route = await routeTo(account, target, { signal: opts.signal });
      if (route.reason !== 'arrived') return route.reason === 'aborted' ? 'aborted' : route.reason;
      if (objective.type === 'dock_at_base') await ensureDocked(account);
      return 'ok';
    }

    default:
      return 'unsatisfiable';
  }
}

/** Cheapest item on the local exchange we could buy `quantity` of. */
async function cheapestPurchase(account: Account, quantity: number): Promise<string | undefined> {
  const rows = await marketHere(account);
  const affordable = rows
    .filter((r) => r.best_sell > 0 && r.best_sell_qty >= quantity)
    .sort((a, b) => a.best_sell - b.best_sell);
  return affordable[0]?.item_id;
}

/**
 * Item we can put on the market in `quantity`, best proceeds first. Considers
 * cargo *and* station storage, since a docked trader's stock is usually in
 * storage and only needs withdrawing.
 */
async function mostSellableHolding(account: Account, quantity: number): Promise<string | undefined> {
  const rows = await marketHere(account);
  const pooled = new Map<string, number>();
  for (const c of account.cargo ?? []) {
    if (c.item_id && c.quantity) pooled.set(c.item_id, (pooled.get(c.item_id) ?? 0) + c.quantity);
  }
  for (const s of await storageHere(account)) {
    if (s.item_id && s.quantity) pooled.set(s.item_id, (pooled.get(s.item_id) ?? 0) + s.quantity);
  }

  const holdings = [...pooled].map(([item_id, qty]) => ({ item_id, quantity: qty }));
  return sellableHere(holdings, rows).find((s) => s.quantity >= quantity)?.itemId;
}

// ---------------------------------------------------------------------------
// Loop 2 — arbitrage (no mission)
// ---------------------------------------------------------------------------

export interface ArbitrageResult {
  reason: 'sold' | 'no-spread' | 'no-route' | 'insufficient-fuel' | 'fuel-reserve' | 'aborted' | 'error';
  itemId?: string;
  bought: number;
  spent: number;
  earned: number;
  /** Net of purchase cost; excludes fuel. */
  profit: number;
  error?: Error;
}

/**
 * One buy-here / sell-there round trip against a named destination base.
 *
 * Scouting is the expensive part: the far book is only readable while docked
 * there, so this takes the destination's rows as an argument. A caller that
 * runs a circuit keeps a price map from its last visit and feeds it in — which
 * is exactly what `submit_trade_intel` exists to share across a faction.
 */
export async function runArbitrageCycle(
  account: Account,
  destinationBaseId: string,
  destinationRows: readonly MarketListingItem[],
  opts: { onProgress?: (p: { step: string; detail?: string }) => void; signal?: AbortSignal; minProfit?: number } = {},
): Promise<ArbitrageResult> {
  const empty: ArbitrageResult = { reason: 'no-spread', bought: 0, spent: 0, earned: 0, profit: 0 };
  try {
    await ensureDocked(account);
    const here = await marketHere(account);

    const [best] = findSpreads(here, destinationRows, {
      capacity: holdSpace(account).free,
      minProfit: opts.minProfit ?? 1,
    });
    if (!best) return empty;

    opts.onProgress?.({ step: 'buying', detail: `${best.quantity} x ${best.itemId} @ ${best.ask}` });
    const bought = await buyHere(account, best.itemId, best.quantity);
    if (bought.quantity === 0) return { ...empty, itemId: best.itemId };

    await ensureFuel(account, { min: 0.5 });
    opts.onProgress?.({ step: 'hauling', detail: destinationBaseId });
    const route = await routeTo(account, destinationBaseId, { signal: opts.signal });
    if (route.reason !== 'arrived') {
      const reason = route.reason === 'aborted' ? 'aborted' : route.reason;
      return { ...empty, reason, itemId: best.itemId, bought: bought.quantity, spent: bought.credits };
    }

    await ensureDocked(account);
    opts.onProgress?.({ step: 'selling', detail: `${bought.quantity} x ${best.itemId}` });
    const sold = await sellHere(account, best.itemId, bought.quantity);

    return {
      reason: 'sold',
      itemId: best.itemId,
      bought: bought.quantity,
      spent: bought.credits,
      earned: sold.credits,
      profit: sold.credits - bought.credits,
    };
  } catch (error) {
    return { ...empty, reason: 'error', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// ---------------------------------------------------------------------------
// Demo: run one trading mission and report. The loop stays silent; this caller
// owns all rendering.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { Account } = await import('../src/index.ts');
  const username = process.env.SPACEMOLT_USERNAME;
  const password = process.env.SPACEMOLT_PASSWORD;
  if (!username || !password) {
    console.error('set SPACEMOLT_USERNAME and SPACEMOLT_PASSWORD (see docs/live-testing.md)');
    process.exit(1);
  }

  const account = new Account({ url: process.env.SPACEMOLT_URL });
  await account.connect();
  await account.login({ username, password });

  const result = await runTradingMission(account, {
    onProgress: (p) => console.log(`  ${p.step}${p.detail ? `: ${p.detail}` : ''}`),
  });

  console.log(
    result.reason === 'completed'
      ? `completed "${result.title}" for ${result.credits}cr (credits now ${account.credits})`
      : `stopped: ${result.reason}${result.error ? ` — ${result.error.message}` : ''}`,
  );
  account.close();
}
