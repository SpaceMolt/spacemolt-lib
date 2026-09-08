/**
 * Shared building blocks for gameplay loops — the Sensors, Guards, and Movement
 * layers that every role's loop sits on, plus the pure selectors that decide
 * *what* to do (kept separate from the code that *does* it, so they can be unit
 * tested with plain fixtures and no socket).
 *
 * Same contract as `gameplay-loops.ts`, because the real case is many accounts
 * looping concurrently: nothing here prints, everything returns structured data,
 * and long-running work takes `onProgress` + `signal`.
 *
 * Layering (see the loops that build on this):
 *   Sensors   — read local cache or issue a query. No ticks, no fuel, no risk.
 *   Guards    — assert a precondition, acting only if it isn't already met.
 *   Movement  — locomotion. Costs ticks and fuel; the only layer that strands you.
 *   Selectors — pure functions over data. No I/O.
 */

import { SpacemoltError, heldQuantity as heldQty, mergeInventory } from '../src/index.ts';
import type { Account } from '../src/index.ts';
import type { BookLevel, CargoItem, GameState, MarketListingItem, MissionInfo } from '../src/index.ts';

// ---------------------------------------------------------------------------
// Sensors — reads. Local-cache reads are free; queries cost a round trip but
// never a tick.
// ---------------------------------------------------------------------------

export interface Position {
  systemId?: string;
  poiId?: string;
  /** Base id when docked, else undefined. */
  dockedAt?: string;
  docked: boolean;
}

/** Where we are, normalized. Reads the local cache — no round trip. */
export function position(account: Account): Position {
  const loc = account.location;
  // `docked_at` is nullable on the wire (null = in space), so normalize to
  // undefined and let `docked` be the thing callers branch on.
  return {
    systemId: loc?.system_id ?? undefined,
    poiId: loc?.poi_id ?? undefined,
    dockedAt: loc?.docked_at ?? undefined,
    docked: Boolean(loc?.docked_at),
  };
}

export interface HoldSpace {
  used: number;
  capacity: number;
  free: number;
}

/** Cargo hold occupancy, maintained locally by the state cache. */
export function holdSpace(account: Account): HoldSpace {
  const used = account.ship?.cargo_used ?? 0;
  const capacity = account.ship?.cargo_capacity ?? 0;
  return { used, capacity, free: Math.max(0, capacity - used) };
}

/** How many of `itemId` are in the cargo hold right now. */
export function heldQuantity(account: Account, itemId: string): number {
  return heldQty(mergeInventory(account.cargo ?? []), itemId);
}

export interface FuelState {
  fuel: number;
  max: number;
  /** 0–1. Guards read this rather than raw numbers so thresholds stay ship-agnostic. */
  fraction: number;
}

export function fuelState(account: Account): FuelState {
  const fuel = account.ship?.fuel ?? 0;
  const max = account.ship?.max_fuel ?? 0;
  return { fuel, max, fraction: max > 0 ? fuel / max : 0 };
}

/** Order book at the docked station. Requires being docked. */
export async function marketHere(account: Account): Promise<MarketListingItem[]> {
  return (await account.commands.spacemolt_market.view_market()).structuredContent?.items ?? [];
}

/** Personal storage at the docked station. Crafting reads/writes this, not cargo. */
export async function storageHere(account: Account): Promise<CargoItem[]> {
  const res = (await account.commands.spacemolt_storage.view()).structuredContent;
  // The response is a union (personal | faction storage); only the personal
  // shape carries `items`, which is what the default (no target) call returns.
  return res && 'items' in res ? (res.items ?? []) : [];
}

/** Quantity of `itemId` in station storage here. */
export async function storedQuantity(account: Account, itemId: string): Promise<number> {
  return (await storageHere(account)).find((i) => i.item_id === itemId)?.quantity ?? 0;
}

/**
 * Ensure `quantity` of an item sits in the *cargo hold*, withdrawing from
 * station storage to make up any shortfall.
 *
 * Selling and hauling read cargo, but goods accumulate in storage — so a loop
 * that only looked at cargo would report "can't do that" while the item sits
 * one withdraw away. Returns how many are in cargo afterwards.
 */
export async function ensureInCargo(account: Account, itemId: string, quantity: number): Promise<number> {
  const held = heldQuantity(account, itemId);
  if (held >= quantity) return held;

  const shortfall = quantity - held;
  const stored = await storedQuantity(account, itemId);
  if (stored <= 0) return held;

  await account.commands.spacemolt_storage.withdraw({ item_id: itemId, quantity: Math.min(shortfall, stored) });
  return heldQuantity(account, itemId);
}

/** Missions offered at the docked station. */
export async function board(account: Account): Promise<MissionInfo[]> {
  return (await account.commands.spacemolt.get_missions()).structuredContent?.missions ?? [];
}

/** Missions we have accepted, from the local cache. */
export function activeMissions(account: Account): NonNullable<NonNullable<GameState['missions']>['active']> {
  return account.state.missions?.active ?? [];
}

/**
 * The identifier a mission is *accepted and re-found* by.
 *
 * `template_id` is optional on the wire: canned board missions (e.g.
 * "workshop_production_run") carry one, but procedurally-generated missions
 * (courier runs, black-market deliveries — verified live, several of these
 * are the highest-reward entries on the board) don't, since each offer is
 * already a unique instance rather than stamped from a shared template. Their
 * `mission_id` is the same live for the board listing and the accepted
 * instance. So the key to match on is template_id when present, else the
 * mission_id itself.
 */
export interface MissionLike {
  template_id?: string;
  mission_id?: string;
}

export function missionAcceptKey(mission: MissionLike): string | undefined {
  return mission.template_id ?? mission.mission_id;
}

/**
 * Find the active-list entry accepted under `key`, checking *either* field
 * rather than recomputing the same accept-key on both sides.
 *
 * Verified live that the board and active views can disagree on which field
 * is populated: a wormhole-intro mission's board listing had no `template_id`
 * (so it was accepted by `mission_id`), but its accepted instance carried
 * *both* a `template_id` and that same `mission_id`. Recomputing
 * `missionAcceptKey` from the active entry would have preferred its
 * (newly-present) template_id and silently missed the match — leaving the
 * mission un-resolvable, and so un-abandonable, even though it was sitting
 * right there in the active list.
 */
export function findActiveMission<T extends MissionLike>(missions: readonly T[], key: string): T | undefined {
  return missions.find((m) => m.template_id === key || m.mission_id === key);
}

/**
 * The *instance* id of an accepted mission, looked up by its accept key.
 *
 * These are two different identifiers for canned missions and mixing them up
 * fails at the last step: you accept by `template_id` ("workshop_production_run")
 * but complete by the per-instance `mission_id` (a hash minted when you
 * accepted). Passing the template to `complete_mission` returns
 * `mission_not_found` *after* all the work is done.
 */
export function activeMissionId(account: Account, mission: MissionLike): string | undefined {
  const key = missionAcceptKey(mission);
  if (!key) return undefined;
  return findActiveMission(activeMissions(account), key)?.mission_id;
}

/** True when this mission is already on our accepted list. */
export function isActive(account: Account, mission: MissionLike): boolean {
  return activeMissionId(account, mission) !== undefined;
}

/**
 * Accept a mission from the board, using whichever identifier it actually
 * carries — `template_id` for canned missions, `mission_id` for procedural
 * ones (see `missionAcceptKey`). Accepting the wrong param name is silent
 * until `complete_mission` fails, so this is the one place that decides it.
 */
export async function acceptMission(account: Account, mission: MissionLike): Promise<void> {
  if (mission.template_id) {
    await account.commands.spacemolt.accept_mission({ template_id: mission.template_id });
    return;
  }
  if (mission.mission_id) {
    await account.commands.spacemolt.accept_mission({ id: mission.mission_id });
    return;
  }
  throw new Error('mission has neither template_id nor mission_id');
}

/**
 * How many the objective asks for.
 *
 * The two views disagree: a mission on the *board* states `quantity`, while the
 * same objective once *accepted* states `required` (alongside `current`). Loops
 * that resume an accepted mission need both.
 */
export function objectiveTarget(objective: { quantity?: number; required?: number }): number {
  return objective.quantity ?? objective.required ?? 0;
}

/**
 * Progress so far on an accepted objective. Board listings carry no `current`
 * at all, so `description` is named here purely to give the two objective
 * shapes a property in common and keep this assignable from either.
 */
export function objectiveProgress(objective: { current?: number; description?: string }): number {
  return objective.current ?? 0;
}

// ---------------------------------------------------------------------------
// Guards — assert a precondition. Each is a no-op when already satisfied, so
// they're safe to call unconditionally at the top of a loop.
// ---------------------------------------------------------------------------

/** Dock if not already docked. Returns whether it had to act. */
export async function ensureDocked(account: Account): Promise<boolean> {
  if (position(account).docked) return false;
  await account.commands.spacemolt.dock();
  return true;
}

/** Undock if currently docked. Returns whether it had to act. */
export async function ensureUndocked(account: Account): Promise<boolean> {
  if (!position(account).docked) return false;
  await account.commands.spacemolt.undock();
  return true;
}

/**
 * Portable fuel, cheapest first. Tank fuel and fuel cells are different things:
 * the tank is what burns when you move, cells are cargo you carry and convert.
 *
 * Ids come from the catalog. (The spec's own prose gives them as
 * `fuel_cell_premium`/`fuel_cell_military`, which do not exist — the catalog is
 * authoritative.)
 */
export const FUEL_CELL_TIERS = [
  { itemId: 'fuel_cell', restores: 20 },
  { itemId: 'premium_fuel_cell', restores: 50 },
  { itemId: 'military_fuel_cell', restores: 100 },
] as const;

export interface FuelCellStock {
  /** item_id -> count held in cargo. */
  byTier: Record<string, number>;
  /** Cells held, any tier. */
  count: number;
  /** Tank units they could restore in total. */
  potential: number;
}

/** Fuel cells currently in the hold. Reads the local cache — free. */
export function fuelCells(account: Account): FuelCellStock {
  const byTier: Record<string, number> = {};
  let count = 0;
  let potential = 0;
  for (const tier of FUEL_CELL_TIERS) {
    const held = heldQuantity(account, tier.itemId);
    if (held <= 0) continue;
    byTier[tier.itemId] = held;
    count += held;
    potential += held * tier.restores;
  }
  return { byTier, count, potential };
}

export interface CellBurn {
  itemId: string;
  count: number;
}

/**
 * Which cells to burn to cover `deficit` tank units, wasting as little as
 * possible, without dropping below `keep` cells in reserve.
 *
 * Overfilling is pure waste — the tank caps at max, so spending a 100-unit
 * military cell to cover a 20-unit gap throws away 80. So this prefers the
 * *smallest* cell that closes the remaining gap, and only reaches for a bigger
 * one when nothing smaller will do.
 *
 * Pure, so the arithmetic is testable without a socket.
 */
export function planCellBurn(deficit: number, stock: FuelCellStock, keep = 1): CellBurn[] {
  const available: Record<string, number> = { ...stock.byTier };
  let budget = Math.max(0, stock.count - keep);
  let remaining = deficit;
  const burn: Record<string, number> = {};

  while (remaining > 0 && budget > 0) {
    const usable = FUEL_CELL_TIERS.filter((t) => (available[t.itemId] ?? 0) > 0);
    if (usable.length === 0) break;
    // Smallest cell that covers what's left, else the largest we have.
    const pick = usable.find((t) => t.restores >= remaining) ?? usable[usable.length - 1];
    if (!pick) break;

    available[pick.itemId] = (available[pick.itemId] ?? 0) - 1;
    burn[pick.itemId] = (burn[pick.itemId] ?? 0) + 1;
    remaining -= pick.restores;
    budget--;
  }

  return Object.entries(burn).map(([itemId, count]) => ({ itemId, count }));
}

export interface FuelResult {
  /** Fuel units added (0 when the guard was already satisfied). */
  added: number;
  fuel: number;
  /** Cells burned, by item id. */
  cellsUsed: CellBurn[];
  /** Cells still in the hold afterwards. */
  cellsRemaining: number;
  /** True when we're down to the reserve and routing should pause. */
  atReserve: boolean;
}

export interface EnsureFuelOptions {
  /** Act only when below this fraction of max fuel. Default 0.5. */
  min?: number;
  /** Burn cells from cargo to make up any shortfall. Default true. */
  useCells?: boolean;
  /**
   * Cells to keep unburned. Default 1 — the resupply reserve.
   *
   * The last cell is what guarantees you can still reach a station to restock.
   * Pass 0 when that *is* the resupply run.
   */
  keepCells?: number;
}

/**
 * Bring fuel up, from the station tank if we're docked and from cargo cells
 * otherwise (or additionally, when the station couldn't finish the job).
 *
 * Two things about `refuel` that the parameter names hide:
 *
 * - **Station refuelling ignores `quantity` and always fills the tank to full**,
 *   charging for it. There is no partial station top-up, so a `target` option
 *   would be a lie; this takes only a `min` threshold.
 * - **`quantity` counts *cells to burn*, not fuel units.** Passing a unit count
 *   while undocked would try to burn that many cells.
 */
export async function ensureFuel(account: Account, opts: EnsureFuelOptions = {}): Promise<FuelResult> {
  const { min = 0.5, useCells = true, keepCells = 1 } = opts;
  const before = fuelState(account);

  const result = (): FuelResult => {
    const after = fuelState(account);
    const cells = fuelCells(account);
    return {
      added: after.fuel - before.fuel,
      fuel: after.fuel,
      cellsUsed: [],
      cellsRemaining: cells.count,
      atReserve: cells.count > 0 && cells.count <= keepCells,
    };
  };

  if (before.max === 0 || before.fraction >= min) return result();

  // Station first: it's the only source that doesn't consume cargo.
  if (position(account).docked) {
    try {
      await account.commands.spacemolt.refuel({});
    } catch {
      // Dry station, no refuel service, or not enough credits — fall through.
    }
  }

  const cellsUsed: CellBurn[] = [];
  if (useCells) {
    const deficit = fuelState(account).max - fuelState(account).fuel;
    for (const burn of planCellBurn(deficit, fuelCells(account), keepCells)) {
      try {
        await account.commands.spacemolt.refuel({ id: burn.itemId, quantity: burn.count });
        cellsUsed.push(burn);
      } catch {
        // Cell type unusable here; try the next.
      }
    }
  }

  return { ...result(), cellsUsed };
}

/**
 * Are we down to the reserve, so automated routing should stop and let a human
 * (or a smarter planner) decide?
 *
 * A pilot carrying no cells at all isn't held back — there's no reserve to
 * protect and they were never relying on one. The gate exists to stop you
 * *spending* the last of a reserve you were depending on.
 */
export function atFuelCellReserve(account: Account, reserve = 1): boolean {
  const { count } = fuelCells(account);
  return count > 0 && count <= reserve;
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export interface RouteResult {
  arrivedAt?: string;
  hops: number;
  reason: 'arrived' | 'no-route' | 'insufficient-fuel' | 'aborted' | 'fuel-reserve';
}

/**
 * Travel to any destination `find_route` understands — a system, a POI, or a
 * named base — jumping each hop, then closing the last intra-system leg to
 * the exact POI if the destination was one. This generalizes `jumpToSystem`
 * from `gameplay-loops.ts`: because the server resolves base ids
 * galaxy-wide, it is the universal "get me there", including the trip home.
 *
 * Undocks first if needed. Returns a reason rather than throwing, so a fleet
 * caller can branch without try/catch.
 */
export async function routeTo(
  account: Account,
  destinationId: string,
  opts: {
    onArrive?: (hop: { systemId: string; remaining: number }) => void;
    signal?: AbortSignal;
    /**
     * Refuse to set out while down to this many fuel cells. Default 1.
     *
     * The last cell is the resupply reserve: whatever else has gone wrong, it
     * guarantees one more hop toward a station. Spending it on ordinary
     * routing is how a pilot ends up adrift, so automated movement stops here
     * and hands the decision back. **Pass 0 when this trip *is* the resupply
     * run** — that is the intended escape hatch, and the only way past the
     * gate.
     */
    fuelCellReserve?: number;
  } = {},
): Promise<RouteResult> {
  if (position(account).systemId === destinationId) return { arrivedAt: destinationId, hops: 0, reason: 'arrived' };
  if (atFuelCellReserve(account, opts.fuelCellReserve ?? 1)) {
    return { hops: 0, reason: 'fuel-reserve' };
  }

  const plan = (await account.commands.spacemolt.find_route({ id: destinationId })).structuredContent;
  if (!plan?.found) return { hops: 0, reason: 'no-route' };
  if (plan.estimated_fuel > plan.fuel_available) return { hops: 0, reason: 'insufficient-fuel' };

  await ensureUndocked(account);

  const hopsToMake = plan.route.filter((h) => h.system_id !== position(account).systemId);
  let hops = 0;
  for (const hop of hopsToMake) {
    if (opts.signal?.aborted) return { arrivedAt: position(account).systemId, hops, reason: 'aborted' };
    await account.commands.spacemolt.jump({ id: hop.system_id });
    hops++;
    opts.onArrive?.({ systemId: hop.system_id, remaining: hopsToMake.length - hops });
  }

  // `jump` only gets you into the destination *system* — you land at whatever
  // POI is that system's entrance point, which is not necessarily the named
  // base/POI `destinationId` actually pointed at. Verified live: docking at a
  // named base right after the jump loop failed with `no_base` ("No station
  // at this location") — `find_route`'s `target_poi` is the intra-system leg
  // `jump` never takes, and `travel` is what closes it.
  if (opts.signal?.aborted) return { arrivedAt: position(account).systemId, hops, reason: 'aborted' };
  if (plan.target_poi && position(account).poiId !== plan.target_poi) {
    await ensureUndocked(account);
    await account.commands.spacemolt.travel({ id: plan.target_poi });
  }

  return { arrivedAt: position(account).systemId, hops, reason: 'arrived' };
}

// ---------------------------------------------------------------------------
// Selectors — pure. No account, no I/O, no awaits. `bestBid`/`bestAsk`/
// `bidDepth`/`walkBook` moved to `src/data/market-value.ts`; only the
// account-bound `orderBook` stays here.
// ---------------------------------------------------------------------------

export interface OrderBook {
  itemId: string;
  /** Bids, best first. */
  bids: BookLevel[];
  /** Total units wanted across every level. */
  bidQuantity: number;
  asks: BookLevel[];
  askQuantity: number;
}

/**
 * The full order ladder for one item at the docked station.
 *
 * `view_market()` unfiltered summarises each item to its best level; passing
 * `item_id` returns the whole ladder plus the `buy_quantity`/`sell_quantity`
 * totals. Two different questions, and the summary quietly answers the smaller
 * one.
 */
export async function orderBook(account: Account, itemId: string): Promise<OrderBook> {
  const item = (await account.commands.spacemolt_market.view_market({ item_id: itemId })).structuredContent?.items?.[0];
  const levels = (orders: readonly { price_each?: number; quantity?: number }[] | undefined): BookLevel[] =>
    (orders ?? []).map((o) => ({ price: o.price_each ?? 0, quantity: o.quantity ?? 0 }));
  return {
    itemId,
    bids: levels(item?.buy_orders),
    bidQuantity: item?.buy_quantity ?? 0,
    asks: levels(item?.sell_orders),
    askQuantity: item?.sell_quantity ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Capability — what this pilot can actually attempt.
//
// A fresh account has no skills, one starter module and no weapon, so most of
// the board is off-limits in ways the mission data does not state. Gathering
// that into one value keeps every "can I?" decision in one place.
// ---------------------------------------------------------------------------

export interface Capabilities {
  /** Installed module `type_id`s. */
  modules: string[];
  /** Skill id -> level. Absent skills are level 0. */
  skills: Record<string, number>;
  credits: number;
  cargoCapacity: number;
  /** True when something is fitted in a weapon slot. */
  hasWeapon: boolean;
}

/** Snapshot what this pilot can attempt. Reads the local cache — no round trip. */
export function capabilities(account: Account): Capabilities {
  const modules = account.state.modules ?? [];
  const skills = Object.fromEntries(
    Object.entries(account.skills ?? {}).map(([id, s]) => [id, typeof s?.level === 'number' ? s.level : 0]),
  );
  return {
    modules: modules.flatMap((m) => (typeof m.type_id === 'string' ? [m.type_id] : [])),
    skills,
    credits: account.credits ?? 0,
    cargoCapacity: account.ship?.cargo_capacity ?? 0,
    hasWeapon: modules.some((m) => m.slot === 'weapon'),
  };
}

/** Module `type_id`s currently installed. */
export function installedModules(account: Account): string[] {
  return capabilities(account).modules;
}

/**
 * Mission *type* -> the skill it silently requires.
 *
 * `MissionInfo` has **no skill field at all** — only `required_modules` — and
 * the `warnings` array came back empty on every live mission. So there is no
 * way to see a skill gate in the data; you learn it by attempting to accept and
 * getting `skill_required` back. Verified live: all six smuggling-flavoured
 * board entries rejected with "Smuggling missions require smuggling level 1".
 *
 * This table is therefore *learned knowledge*, not spec-derived. Add to it when
 * a new gate is discovered, and keep `isSkillGateError` as the backstop for
 * gates not yet listed here.
 */
export const TYPE_SKILL_GATES: Record<string, { skill: string; level: number }> = {
  smuggling: { skill: 'smuggling', level: 1 },
};

/** True when an accept failed because of a skill requirement we can't see up front. */
export function isSkillGateError(error: unknown): boolean {
  return error instanceof SpacemoltError && error.code === 'skill_required';
}

/**
 * Can this pilot attempt this mission? Three gates, in order of how visible
 * they are:
 *
 * 1. `required_modules` — stated in the data.
 * 2. Known type->skill gates (`TYPE_SKILL_GATES`) — *not* in the data.
 * 3. Combat without a weapon — not a rule the server enforces, but attempting
 *    it destroys the ship, which for a fresh pilot ends the run. Treated as
 *    infeasible unless something is fitted in a weapon slot.
 *
 * Accepting a mission we can't finish burns one of five slots, so loops check
 * before accepting rather than discovering it at completion time.
 */
export function feasible(mission: MissionInfo, caps: Capabilities): boolean {
  if (!(mission.required_modules ?? []).every((m) => caps.modules.includes(m))) return false;

  const gate = mission.type ? TYPE_SKILL_GATES[mission.type] : undefined;
  if (gate && (caps.skills[gate.skill] ?? 0) < gate.level) return false;

  if (!caps.hasWeapon && hasObjective(mission, 'kill_creature')) return false;

  return true;
}

export interface MissionPick {
  mission: MissionInfo;
  credits: number;
}

/**
 * Highest-paying mission matching `predicate` that this pilot can actually do.
 *
 * `exclude` holds accept keys already known to be unavailable — a mission that
 * rejected with a skill gate we hadn't listed, say. Without it a loop retries
 * the same doomed mission every cycle, because it stays the highest-paying
 * option on the board forever.
 *
 * Returns undefined rather than throwing when nothing is suitable; an empty
 * board is a normal outcome.
 */
export function pickMission(
  missions: readonly MissionInfo[],
  predicate: (m: MissionInfo) => boolean,
  caps: Capabilities,
  exclude: ReadonlySet<string> = new Set(),
): MissionPick | undefined {
  return missions
    .filter((m) => {
      const key = missionAcceptKey(m);
      return (!key || !exclude.has(key)) && predicate(m) && feasible(m, caps);
    })
    .map((m) => ({ mission: m, credits: m.rewards?.credits ?? 0 }))
    .sort((a, b) => b.credits - a.credits)[0];
}

/** True when the mission has an objective of the given type. */
export function hasObjective(mission: MissionInfo, type: string): boolean {
  return (mission.objectives ?? []).some((o) => o.type === type);
}

// ---------------------------------------------------------------------------
// Mission geography — where a mission makes you go.
// ---------------------------------------------------------------------------

export interface MissionStop {
  kind: 'base' | 'system';
  id: string;
}

/** Stable key so stops can go in a Set. */
export function stopKey(stop: MissionStop): string {
  return `${stop.kind}:${stop.id}`;
}

/**
 * The places a mission requires you to physically visit.
 *
 * Only three objective types imply travel; the rest (`mine_resource`,
 * `craft_item`, `sell_item`, `buy_item`) are satisfied wherever you happen to
 * be, so they contribute no stops. A mission with no stops is "local" and free
 * to bundle with anything.
 *
 * This is what makes stacking possible — see `planStack` in
 * `mission-stacking.ts`.
 */
export function missionStops(mission: MissionInfo): MissionStop[] {
  const stops: MissionStop[] = [];
  for (const objective of mission.objectives ?? []) {
    if (objective.target_base_id) stops.push({ kind: 'base', id: objective.target_base_id });
    else if (objective.type === 'visit_system' && objective.system_id) {
      stops.push({ kind: 'system', id: objective.system_id });
    }
  }
  // De-duplicate; a mission can name the same base twice.
  const seen = new Set<string>();
  const unique: MissionStop[] = [];
  for (const stop of stops) {
    const key = stopKey(stop);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(stop);
  }
  return unique;
}
