/**
 * Mission stacking — accept several missions whose destinations overlap and
 * satisfy them all on one circuit.
 *
 * **This is the highest-leverage move discovered so far.** A live board carried
 * four exploration/logistics missions whose stops were almost entirely shared:
 *
 *   frontier_wayfinder_circuit  20,000cr  7 stations
 *   the_memorial                 8,000cr  a subset of those
 *   debris_field_reports         4,500cr  a subset of those
 *   the_proposal                   800cr  a subset of those
 *
 * Run serially that is four separate tours. Run stacked it is **one** tour for
 * 33,300cr, because the three smaller missions add *no travel at all* — their
 * stops are already on the big one's route. Picking missions one at a time by
 * reward, as `pickMission` does, cannot see this: it would take the 20,000cr
 * mission and leave 13,300cr of free work on the board.
 *
 * The planner is pure and the tour is I/O, kept separate so the interesting
 * decision is unit-testable.
 */

import type { Account } from '../src/index.ts';
import type { MissionInfo } from '../src/index.ts';
import {
  type Capabilities,
  type MissionStop,
  acceptMission,
  activeMissionId,
  activeMissions,
  board,
  capabilities,
  ensureDocked,
  ensureFuel,
  feasible,
  fuelState,
  isActive,
  isSkillGateError,
  missionAcceptKey,
  missionStops,
  position,
  routeTo,
  stopKey,
} from './loop-primitives.ts';

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

export interface Stack {
  missions: MissionInfo[];
  /** Every place the circuit must visit, de-duplicated. */
  stops: MissionStop[];
  /** Sum of advertised rewards. */
  credits: number;
  /** Reward per stop — the figure worth comparing between candidate stacks. */
  creditsPerStop: number;
}

export interface StackOptions {
  /** Refuse a stack needing more than this many stops. */
  maxStops?: number;
  /**
   * How many *new* stops a mission may add to still be worth bundling. 0 means
   * free-riders only (strict subset of the anchor's route).
   */
  allowExtraStops?: number;
  /** Accept keys to skip (already active, or known-blocked). */
  exclude?: ReadonlySet<string>;
  /**
   * Hard cap on missions in the stack. **Defaults to 5, the server's active-
   * mission limit** (`max_missions` in the missions state). Overshooting isn't
   * merely wasteful — the surplus accepts simply fail.
   */
  maxMissions?: number;
  /**
   * Which missions this stack is allowed to contain. Defaults to
   * `isTourSatisfiable`, because a tour only travels.
   */
  satisfiable?: (m: MissionInfo) => boolean;
  /**
   * Whether a given stop is worth/safe to include. Defaults to allowing
   * everything, because the planner is pure and has no fuel data.
   *
   * **Supply this from real routing costs.** Stops are counted, not measured:
   * one 1 hop away and one 30 hops away score identically, so on stop-count
   * alone the planner will happily anchor on a mission whose destination the
   * ship cannot return from. Caught live — `the_crucible` priced at 58 fuel
   * one-way against a 100-unit tank, i.e. reachable but not returnable, and it
   * ranked *first* at 2,000cr per stop. `runMissionTour` passes a predicate
   * built from `find_route` estimates.
   */
  stopAllowed?: (stop: MissionStop) => boolean;
}

/**
 * Split stops into those needing a real journey and those we're already sitting
 * in, which must be *arrived at* later rather than ticked off in place.
 *
 * `routeTo` short-circuits to `arrived` when you're already in the target
 * system, so a `visit_system` objective naming your current system gets
 * "visited" by standing still — and the server, correctly, does not count that.
 * Verified live: a survey accepted while sitting in `horizon` toured its two
 * other systems, returned, and still read 0/1 on horizon. Leaving and coming
 * back does tick it, so those stops are deferred to the end where the trip home
 * supplies a genuine arrival.
 *
 * Only `system` stops are affected; a `base` stop still needs `travel` + `dock`
 * within the system, which is real movement either way.
 */
export function deferSameSystemStops(
  stops: readonly MissionStop[],
  currentSystemId: string | undefined,
): { remaining: MissionStop[]; deferred: MissionStop[] } {
  const isHere = (s: MissionStop) => s.kind === 'system' && !!currentSystemId && s.id === currentSystemId;
  return { remaining: stops.filter((s) => !isHere(s)), deferred: stops.filter(isHere) };
}

/** Objective types a tour satisfies simply by showing up. */
const TRAVEL_OBJECTIVES = new Set(['dock_at_base', 'visit_system']);

/**
 * Can a pure travel circuit finish this mission?
 *
 * Only if *every* objective is discharged by arriving somewhere. This matters
 * more than it looks: replaying the planner over a real 28-mission board, an
 * earlier version happily bundled `mine_resource` and `craft_item` missions as
 * "free riders" because they name no destination — so they added no travel.
 * But `runMissionTour` never mines and never crafts, so those missions would be
 * accepted, never progress, and sit there consuming slots out of a cap of five.
 *
 * Free travel is not the same as free work.
 */
export function isTourSatisfiable(mission: MissionInfo): boolean {
  const objectives = mission.objectives ?? [];
  return objectives.length > 0 && objectives.every((o) => o.type && TRAVEL_OBJECTIVES.has(o.type));
}

/**
 * Build the best stack around the highest-paying feasible mission.
 *
 * Anchor-and-free-riders: take the biggest mission as the anchor, then walk the
 * rest by reward and bundle any whose stops the anchor's route already covers.
 * With `allowExtraStops > 0` it will also take missions that add a little
 * detour. Greedy rather than optimal — an exact set-cover is overkill when the
 * board holds a couple of dozen missions and the anchor dominates the route.
 *
 * Missions with no stops at all (`craft_item`, `sell_item`, mine-anywhere) are
 * always free riders: they cost no travel, so they bundle with anything.
 */
export function planStack(
  missions: readonly MissionInfo[],
  caps: Capabilities,
  opts: StackOptions = {},
): Stack | undefined {
  const {
    maxStops = Number.POSITIVE_INFINITY,
    allowExtraStops = 0,
    exclude = new Set<string>(),
    maxMissions = 5,
    satisfiable = isTourSatisfiable,
    stopAllowed = () => true,
  } = opts;

  const eligible = missions
    .filter((m) => {
      const key = missionAcceptKey(m);
      if (key && exclude.has(key)) return false;
      if (!satisfiable(m) || !feasible(m, caps) || (m.rewards?.credits ?? 0) <= 0) return false;
      // One unreachable stop disqualifies the whole mission — you cannot part-
      // complete your way out of being stranded.
      return missionStops(m).every(stopAllowed);
    })
    .sort((a, b) => (b.rewards?.credits ?? 0) - (a.rewards?.credits ?? 0));

  const anchor = eligible[0];
  if (!anchor) return undefined;

  const chosen: MissionInfo[] = [anchor];
  const covered = new Set(missionStops(anchor).map(stopKey));
  const stops: MissionStop[] = [...missionStops(anchor)];
  if (stops.length > maxStops) return undefined;

  for (const mission of eligible.slice(1)) {
    if (chosen.length >= maxMissions) break;
    const own = missionStops(mission);
    const novel = own.filter((s) => !covered.has(stopKey(s)));
    if (novel.length > allowExtraStops) continue;
    if (stops.length + novel.length > maxStops) continue;

    chosen.push(mission);
    for (const s of novel) {
      covered.add(stopKey(s));
      stops.push(s);
    }
  }

  const credits = chosen.reduce((sum, m) => sum + (m.rewards?.credits ?? 0), 0);
  return { missions: chosen, stops, credits, creditsPerStop: stops.length > 0 ? credits / stops.length : credits };
}

// ---------------------------------------------------------------------------
// Tour (I/O)
// ---------------------------------------------------------------------------

export type TourStopReason =
  | 'completed'
  | 'partial'
  | 'no-stack'
  | 'low-fuel'
  /** Down to the last fuel cell — paused so a resupply can be planned. */
  | 'fuel-reserve'
  | 'aborted'
  | 'error';

export interface TourResult {
  reason: TourStopReason;
  /** Missions accepted at the start of the tour. */
  accepted: string[];
  /** Missions that completed and paid out. */
  completed: string[];
  /** Advertised total for the completed set. Actual payouts can differ — see below. */
  credits: number;
  stopsVisited: number;
  error?: Error;
}

export interface TourOptions {
  onProgress?: (p: { step: string; detail?: string }) => void;
  signal?: AbortSignal;
  /** Abort the circuit and head home below this fuel fraction. Default 0.2. */
  minFuelFraction?: number;
  /** Where to return and complete. Defaults to wherever we started. */
  homeBaseId?: string;
  maxStops?: number;
  allowExtraStops?: number;
  /**
   * Fraction of the tank to hold back when judging whether a stop is safely
   * round-trippable. Default 0.15.
   */
  fuelReserve?: number;
  /** Server cap on simultaneously-active missions. Default 5. */
  missionSlots?: number;
  /**
   * How strictly to judge a stop reachable. `one-way` (default) asks only that
   * the leg fit in a tank, since fuel is generally purchasable en route and at
   * the destination. `round-trip` demands out-and-back fit in one tank — use it
   * when the destination may have no fuel to sell.
   */
  reachability?: 'one-way' | 'round-trip';
}

/**
 * Accept a stack, tour its stops, then come home and complete everything that
 * finished.
 *
 * Ordering is greedy nearest-first by `find_route`'s fuel estimate. That's a
 * query, so probing every remaining stop each time costs round trips but no
 * ticks and no fuel — cheap next to flying a bad order.
 *
 * Two things learned the hard way, both encoded here:
 *
 * - **Re-read mission progress from the server before completing.** The local
 *   cache reported every objective incomplete at the end of a live circuit
 *   while a fresh `get_active_missions()` showed three of four actually done.
 *   Trusting the cache would have walked away from 28,800cr.
 * - **Advertised rewards are ceilings, not prices — especially for
 *   exploration.** Survey and cartography missions pay for *fresh* data. Their
 *   own dialog says so ("visit 3 systems I haven't had recent data from"), and
 *   it bites hard: a 2,500cr survey of systems we routinely fly through paid
 *   **0**, and a 4,500cr beacon survey paid **230**. Both completed
 *   successfully — the work was simply worth nothing.
 *
 *   Since `planStack` ranks by advertised credits, it will systematically
 *   overvalue exploration missions covering your own back yard. Prefer stops
 *   you rarely visit, and read real income off `account.credits` rather than
 *   `TourResult.credits`, which is only the advertised total.
 */
export async function runMissionTour(account: Account, opts: TourOptions = {}): Promise<TourResult> {
  const minFuel = opts.minFuelFraction ?? 0.2;
  const empty: TourResult = { reason: 'no-stack', accepted: [], completed: [], credits: 0, stopsVisited: 0 };

  try {
    await ensureDocked(account);
    const home = opts.homeBaseId ?? position(account).dockedAt;

    const offered = await board(account);

    // Slots, not missions. `maxMissions` caps the *total* you may hold, so a
    // stack sized to the cap fails outright when anything is already accepted —
    // and ambient zero-reward missions (distress calls, for one) accumulate
    // quietly. Observed live: five of them held every slot on this account.
    const held = activeMissions(account).length;
    const freeSlots = Math.max(0, (opts.missionSlots ?? 5) - held);
    if (freeSlots === 0) {
      opts.onProgress?.({ step: 'no-slots', detail: `${held} mission(s) already active` });
      return empty;
    }
    opts.onProgress?.({ step: 'slots', detail: `${freeSlots} free of ${opts.missionSlots ?? 5}` });

    // Price every candidate stop *before* planning. `find_route` is a query, so
    // this costs round trips but no ticks and no fuel — trivially cheap next to
    // committing to a destination we can't come back from.
    const reachable = await affordableStops(account, offered, opts.fuelReserve ?? 0.15, opts.reachability ?? 'one-way');
    opts.onProgress?.({ step: 'priced', detail: `${reachable.size} stop(s) within round-trip range` });

    const stack = planStack(offered, capabilities(account), {
      maxStops: opts.maxStops,
      allowExtraStops: opts.allowExtraStops,
      maxMissions: freeSlots,
      stopAllowed: (s) => reachable.has(stopKey(s)),
    });
    if (!stack || stack.stops.length === 0) return empty;

    opts.onProgress?.({
      step: 'planned',
      detail: `${stack.missions.length} mission(s), ${stack.stops.length} stop(s), ~${stack.credits}cr`,
    });

    // Accept everything up front. A skill gate we hadn't catalogued shows up
    // here rather than in `feasible`, so tolerate it and carry on.
    const accepted: MissionInfo[] = [];
    for (const mission of stack.missions) {
      try {
        if (!isActive(account, mission)) await acceptMission(account, mission);
        accepted.push(mission);
      } catch (error) {
        if (!isSkillGateError(error)) throw error;
        opts.onProgress?.({ step: 'skipped', detail: `${mission.title}: skill-gated` });
      }
    }
    if (accepted.length === 0) return empty;

    // Top up before leaving; refuelling mid-circuit depends on the stop selling fuel.
    await ensureFuel(account, { min: 0.9 });

    // Stops we're already sitting in must be arrived at, not ticked in place.
    const { remaining, deferred } = deferSameSystemStops(stack.stops, position(account).systemId);
    if (deferred.length > 0) {
      opts.onProgress?.({
        step: 'deferred',
        detail: `${deferred.map((s) => s.id).join(', ')} — already here; will arrive on the way back`,
      });
    }

    let visited = 0;
    let hitReserve = false;
    while (remaining.length > 0) {
      if (opts.signal?.aborted) break;
      if (fuelState(account).fraction < minFuel) {
        opts.onProgress?.({ step: 'low-fuel', detail: 'heading home' });
        break;
      }

      const next = await nearestStop(account, remaining);
      remaining.splice(remaining.indexOf(next), 1);

      // Top up before committing to the leg if we're carrying less than it
      // costs. Refuelling is what makes long circuits viable at all, so try it
      // before treating a leg as unaffordable.
      const cost = await legCost(account, next.id);
      if (cost === undefined) {
        opts.onProgress?.({ step: 'unreachable', detail: `${next.id}: no route` });
        continue;
      }
      if (cost > fuelState(account).fuel) {
        await ensureFuel(account, { min: 1 }).catch(() => undefined);
        if (cost > fuelState(account).fuel) {
          opts.onProgress?.({
            step: 'skipped',
            detail: `${next.id}: needs ${cost} fuel, have ${fuelState(account).fuel}`,
          });
          continue;
        }
      }

      opts.onProgress?.({ step: 'travelling', detail: `${next.kind}:${next.id}` });
      const route = await routeTo(account, next.id, { signal: opts.signal });
      if (route.reason === 'fuel-reserve') {
        // Not a per-stop problem — the whole circuit stops here so a resupply
        // can be planned while the last cell is still in hand.
        opts.onProgress?.({ step: 'fuel-reserve', detail: 'down to the reserve cell; stopping' });
        hitReserve = true;
        break;
      }
      if (route.reason !== 'arrived') {
        opts.onProgress?.({ step: 'unreachable', detail: `${next.id}: ${route.reason}` });
        continue;
      }
      if (next.kind === 'base') await ensureDocked(account);
      visited++;
      // Refuel opportunistically — not every stop sells it, so ignore failures.
      await ensureFuel(account, { min: 0.6 }).catch(() => undefined);
    }

    if (home) {
      opts.onProgress?.({ step: 'returning', detail: home });
      // Route to the *base*, not its system: `find_route` carries a
      // `target_poi` for a base id and `routeTo` closes that intra-system leg,
      // which is what makes `dock()` work. Routing to a bare system id leaves
      // you at the system's entrance POI, where docking fails with `no_base`.
      await routeTo(account, home, { signal: opts.signal });
      await ensureDocked(account);
      // Arriving home is the real arrival that discharges any deferred
      // same-system stop.
      visited += deferred.filter((s) => s.id === position(account).systemId).length;
    }

    const completed = await completeFinished(account, accepted, opts);
    const credits = completed.reduce((sum, m) => sum + (m.rewards?.credits ?? 0), 0);

    return {
      reason: hitReserve ? 'fuel-reserve' : completed.length === accepted.length ? 'completed' : 'partial',
      accepted: accepted.map((m) => m.title ?? '?'),
      completed: completed.map((m) => m.title ?? '?'),
      credits,
      stopsVisited: visited,
    };
  } catch (error) {
    return { ...empty, reason: 'error', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Which stops are reachable, by the chosen `reachability` rule.
 *
 * **Fuel is renewable, so the tank is not the trip budget.** A thirty-hop
 * journey passes through many systems, most with stations selling fuel, so
 * requiring a whole round trip to fit in one tank rejects perfectly ordinary
 * long hauls. The default (`one-way`) therefore asks only that each *leg* fit
 * in a tank, on the assumption you can top up at or near the destination.
 *
 * `round-trip` is the paranoid mode: it demands out-and-back fit in a single
 * tank, appropriate when you cannot count on fuel being for sale where you are
 * going (deep frontier, dry stations — station fuel reserves do run out). It
 * costs you range: on a live board it rejected `the_crucible` at 58 fuel
 * one-way against a 100-unit tank.
 *
 * Neither rule saves you from a single leg longer than one tank, because
 * `routeTo` jumps straight through intermediate systems without stopping to
 * refuel. Those trips need staging by hand.
 */
async function affordableStops(
  account: Account,
  missions: readonly MissionInfo[],
  reserve: number,
  reachability: 'one-way' | 'round-trip',
): Promise<Set<string>> {
  const budget = fuelState(account).max * (1 - reserve);
  const legs = reachability === 'round-trip' ? 2 : 1;
  const ok = new Set<string>();

  const distinct = new Map<string, MissionStop>();
  for (const mission of missions) {
    for (const stop of missionStops(mission)) distinct.set(stopKey(stop), stop);
  }

  for (const [key, stop] of distinct) {
    try {
      const plan = (await account.commands.spacemolt.find_route({ id: stop.id })).structuredContent;
      if (plan?.found && plan.estimated_fuel * legs <= budget) ok.add(key);
    } catch {
      // Unroutable right now; leave it out rather than guess.
    }
  }
  return ok;
}

/** Fuel to reach `target` from here, or undefined if unroutable. A query. */
async function legCost(account: Account, target: string): Promise<number | undefined> {
  try {
    const plan = (await account.commands.spacemolt.find_route({ id: target })).structuredContent;
    return plan?.found ? plan.estimated_fuel : undefined;
  } catch {
    return undefined;
  }
}

/** Cheapest remaining stop to reach from here, by `find_route` fuel estimate. */
async function nearestStop(account: Account, stops: readonly MissionStop[]): Promise<MissionStop> {
  let best = stops[0] as MissionStop;
  let bestFuel = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    try {
      const plan = (await account.commands.spacemolt.find_route({ id: stop.id })).structuredContent;
      if (plan?.found && plan.estimated_fuel < bestFuel) {
        bestFuel = plan.estimated_fuel;
        best = stop;
      }
    } catch {
      // Unroutable right now; leave it at the back of the queue.
    }
  }
  return best;
}

/**
 * Complete every accepted mission whose objectives the *server* reports done.
 *
 * Deliberately re-queries rather than reading `account.state.missions` — see
 * the stale-cache note on `runMissionTour`.
 */
async function completeFinished(
  account: Account,
  accepted: readonly MissionInfo[],
  opts: TourOptions,
): Promise<MissionInfo[]> {
  const fresh = (await account.commands.spacemolt.get_active_missions()).structuredContent?.missions?.active ?? [];
  const done: MissionInfo[] = [];

  for (const mission of accepted) {
    const key = missionAcceptKey(mission);
    if (!key) continue;
    const live = fresh.find((m) => m.template_id === key || m.mission_id === key);
    if (!live) continue;
    if (!(live.objectives ?? []).every((o) => o.completed)) continue;

    const id = live.mission_id ?? activeMissionId(account, mission);
    if (!id) continue;
    try {
      await account.commands.spacemolt.complete_mission({ id });
      done.push(mission);
      opts.onProgress?.({ step: 'completed', detail: mission.title });
    } catch (error) {
      opts.onProgress?.({
        step: 'complete-failed',
        detail: `${mission.title}: ${error instanceof Error ? error.message : error}`,
      });
    }
  }
  return done;
}
