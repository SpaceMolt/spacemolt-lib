/**
 * Miner loops — the Extraction layer and the mining mission frame.
 *
 * The awkward part of mining is not `mine()`, it's *getting to ore*:
 *
 *   - **A system's POIs are invisible until you are in that system.** Neither
 *     `get_map({system_id})` nor `inspect` returns a POI list for anywhere else
 *     — verified live, even for systems already visited. The bulk `/api/map` is
 *     systems and connections only. So finding a belt is irreducibly
 *     visit-and-look.
 *   - **A POI's resources are invisible until you are at that POI.** The system
 *     view gives each POI a `type` but no contents, so `asteroid_belt` is a
 *     *candidate*, not a confirmation.
 *   - **Your home system may have no belt at all.** Verified live for `horizon`.
 *
 * That makes `findBelt` a search that spends fuel, which makes stranding the
 * real hazard — hence `homeBaseId`, which turns "don't run out of fuel" from a
 * hope into a checked precondition before every jump.
 *
 * Equipment gates which POIs are even worth visiting: a mining laser works on
 * asteroids, an ice harvester on ice fields, a gas harvester on gas clouds.
 * `mineablePoiTypes` derives that from what is actually fitted.
 */

import type { Account } from '../src/index.ts';
import type { MissionInfo } from '../src/index.ts';
import {
  type Capabilities,
  acceptMission,
  activeMissionId,
  board,
  capabilities,
  ensureDocked,
  ensureUndocked,
  fuelState,
  heldQuantity,
  holdSpace,
  isActive,
  objectiveProgress,
  objectiveTarget,
  pickMission,
  position,
  routeTo,
} from './loop-primitives.ts';

// ---------------------------------------------------------------------------
// Selectors (pure)
// ---------------------------------------------------------------------------

/** Module type -> the POI type it can harvest. */
const HARVESTERS: Record<string, string> = {
  mining: 'asteroid_belt',
  ice_harvester: 'ice_field',
  gas_harvester: 'gas_cloud',
};

/**
 * POI types this ship can actually work, from its fitted modules.
 *
 * A starter Prospector carries only a Mining Laser I, so ice fields and gas
 * clouds are scenery — travelling to one wastes fuel and ticks. Matching on
 * module id substrings because module `type_id`s are e.g. `mining_laser_i`.
 */
export function mineablePoiTypes(caps: Capabilities): string[] {
  const types = new Set<string>();
  for (const moduleId of caps.modules) {
    for (const [needle, poiType] of Object.entries(HARVESTERS)) {
      if (moduleId.includes(needle)) types.add(poiType);
    }
  }
  return [...types];
}

export interface PoiLike {
  id?: string;
  type?: string;
  name?: string;
}

/**
 * POIs in a system worth travelling to, best guess first.
 *
 * Only `type` is available remotely, so this ranks *candidates*; whether a belt
 * actually holds anything is only knowable once you are parked at it.
 */
export function beltCandidates(pois: readonly PoiLike[], mineable: readonly string[]): PoiLike[] {
  return pois.filter((p) => p.id && p.type && mineable.includes(p.type));
}

/** Missions satisfied by mining. */
export function isMiningMission(m: MissionInfo): boolean {
  return (m.objectives ?? []).some((o) => o.type === 'mine_resource');
}

// ---------------------------------------------------------------------------
// Belt finding (I/O)
// ---------------------------------------------------------------------------

export interface BeltResult {
  found: boolean;
  systemId?: string;
  poiId?: string;
  /** Resource ids present, once we're actually parked there. */
  resources: string[];
  jumps: number;
  reason: 'found' | 'exhausted' | 'low-fuel' | 'fuel-reserve' | 'aborted' | 'error';
  error?: Error;
}

export interface FindBeltOptions {
  /** Stop after this many jumps away from the start. Default 2. */
  maxJumps?: number;
  /** Only settle for a belt holding this resource. */
  resourceId?: string;
  /**
   * Base to guarantee a way back to. When set, no jump is taken unless the
   * route home would still be affordable afterwards. **Set this.** Without it
   * the search only respects `minFuelFraction`, which does not know how far
   * away you have wandered.
   */
  homeBaseId?: string;
  /** Never let fuel drop below this fraction. Default 0.35. */
  minFuelFraction?: number;
  /**
   * Systems to try first, in order, before falling back to the blind walk.
   *
   * **Set this whenever you know anything.** The fallback picks the first
   * unvisited neighbour, which is a random walk wearing a search's clothes —
   * caught live hunting hydrogen from `unknown_edge`: it wandered
   * `distant_light → altais → horizon`, found nothing, and gave up, having
   * never tried `frontier`, whose gas cloud we had already *seen and recorded*
   * two runs earlier.
   *
   * POI contents aren't queryable remotely, so knowledge only ever comes from
   * having been somewhere. Throwing it away on the next search is the expensive
   * mistake — a system you've visited should be a lead, not a coin flip.
   */
  preferSystems?: readonly string[];
  onProgress?: (p: { step: string; detail?: string }) => void;
  signal?: AbortSignal;
}

/**
 * Search outward for a mineable POI, starting with the current system.
 *
 * Returns where it settled, or why it gave up. Never throws for the ordinary
 * outcomes — "no belt within range" is information, not an error.
 */
export async function findBelt(account: Account, opts: FindBeltOptions = {}): Promise<BeltResult> {
  const maxJumps = opts.maxJumps ?? 2;
  const minFuel = opts.minFuelFraction ?? 0.35;
  const mineable = mineablePoiTypes(capabilities(account));
  const visited = new Set<string>();
  let jumps = 0;

  const done = (reason: BeltResult['reason'], extra: Partial<BeltResult> = {}): BeltResult => ({
    found: reason === 'found',
    resources: [],
    jumps,
    reason,
    ...extra,
  });

  if (mineable.length === 0) return done('exhausted');

  try {
    for (;;) {
      if (opts.signal?.aborted) return done('aborted');

      const here = await inspectSystem(account);
      if (here.systemId) visited.add(here.systemId);

      const found = await tryPoisHere(account, here.pois, mineable, opts);
      if (found) return done('found', { systemId: here.systemId, poiId: found.poiId, resources: found.resources });

      if (jumps >= maxJumps) return done('exhausted', { systemId: here.systemId });
      if (fuelState(account).fraction < minFuel) return done('low-fuel', { systemId: here.systemId });

      const next = nextSystem(here.connections, visited, opts.preferSystems);
      if (!next) return done('exhausted', { systemId: here.systemId });

      if (!(await canAffordDetour(account, next, opts.homeBaseId))) {
        return done('low-fuel', { systemId: here.systemId });
      }

      opts.onProgress?.({ step: 'jumping', detail: next });
      const route = await routeTo(account, next, { signal: opts.signal });
      if (route.reason === 'fuel-reserve') return done('fuel-reserve', { systemId: here.systemId });
      if (route.reason !== 'arrived') return done(route.reason === 'aborted' ? 'aborted' : 'low-fuel');
      jumps++;
    }
  } catch (error) {
    return done('error', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}

/**
 * Where to go next: a preferred system we haven't tried yet, else the first
 * unvisited neighbour.
 *
 * Preferences are honoured even when they aren't adjacent — `routeTo` will
 * multi-hop to get there — because a known-good destination two jumps away
 * beats an unknown neighbour one jump away.
 */
export function nextSystem(
  connections: readonly string[],
  visited: ReadonlySet<string>,
  prefer: readonly string[] = [],
): string | undefined {
  return prefer.find((s) => !visited.has(s)) ?? connections.find((c) => !visited.has(c));
}

/** The current system's POI list and connections, narrowed past the transit union. */
async function inspectSystem(account: Account): Promise<{ systemId?: string; pois: PoiLike[]; connections: string[] }> {
  const res = (await account.commands.spacemolt.get_system()).structuredContent;
  // While in transit between POIs there is no system view at all.
  if (!res || res.kind === 'transit') return { pois: [], connections: [] };
  return {
    systemId: res.system?.id,
    pois: res.system?.pois ?? [],
    connections: (res.system?.connections ?? []).flatMap((c) => (c.system_id ? [c.system_id] : [])),
  };
}

/** Visit each candidate POI here; return the first with usable resources. */
async function tryPoisHere(
  account: Account,
  pois: readonly PoiLike[],
  mineable: readonly string[],
  opts: FindBeltOptions,
): Promise<{ poiId: string; resources: string[] } | undefined> {
  for (const poi of beltCandidates(pois, mineable)) {
    if (opts.signal?.aborted || !poi.id) return undefined;

    if (position(account).poiId !== poi.id) {
      opts.onProgress?.({ step: 'checking', detail: poi.id });
      await ensureUndocked(account);
      await account.commands.spacemolt.travel({ id: poi.id });
    }

    const resources = (account.location?.resources ?? [])
      .filter((r) => (r.remaining ?? 0) > 0)
      // The location cache keys resources by `item_id` (the POI schema calls it
      // `resource_id`); this is the one that exists at runtime.
      .flatMap((r) => (r.item_id ? [r.item_id] : []));
    if (resources.length === 0) continue;
    if (opts.resourceId && !resources.includes(opts.resourceId)) continue;

    return { poiId: poi.id, resources };
  }
  return undefined;
}

/**
 * Would jumping to `target` still leave enough fuel to get home?
 *
 * Both legs are priced with `find_route`, which is a query — no tick, no fuel —
 * so the check is free relative to the mistake it prevents.
 */
async function canAffordDetour(account: Account, target: string, homeBaseId?: string): Promise<boolean> {
  const fuel = fuelState(account).fuel;
  const outbound = (await account.commands.spacemolt.find_route({ id: target })).structuredContent;
  if (!outbound?.found) return false;
  if (outbound.estimated_fuel > fuel) return false;
  if (!homeBaseId) return true;

  const home = (await account.commands.spacemolt.find_route({ id: homeBaseId })).structuredContent;
  if (!home?.found) return false;
  // Worst case the return trip from `target` costs no less than from here.
  return outbound.estimated_fuel + home.estimated_fuel <= fuel;
}

// ---------------------------------------------------------------------------
// Mining (I/O)
// ---------------------------------------------------------------------------

export type MineStopReason = 'target-met' | 'full' | 'depleted' | 'no-yield' | 'aborted' | 'error';

export interface MineForResult {
  reason: MineStopReason;
  /** Units of the requested item now held (cargo). */
  held: number;
  /** Total cargo units gained, across every ore that came up. */
  gained: number;
  error?: Error;
}

/**
 * Mine at the current POI until we hold `quantity` of `itemId`, or the hold
 * fills, or the deposit runs dry.
 *
 * **A belt yields a mix, and you don't get to choose.** Chasing one ore usually
 * means the hold fills with everything else first. Measured live at
 * `deep_range_mineral_fields`, going for 20 platinum: the hold hit 50/50 with
 * **7 platinum** and 43 units of carbon, vanadium, tungsten and dark matter,
 * because platinum's richness there was 20 against carbon's 65. Richness is
 * visible in `location.resources` once you're parked, so check it before
 * committing — a low-richness target needs several trips (bank the haul between
 * them) or `jettison` to make room, and neither is automatic here.
 *
 * `gained` reports the whole take, `held` just the target ore. Omit `itemId` to
 * simply fill the hold.
 */
export async function mineFor(
  account: Account,
  {
    itemId,
    quantity = 0,
    onProgress,
    signal,
  }: {
    itemId?: string;
    quantity?: number;
    onProgress?: (p: { held: number; cargoUsed: number; cargoCapacity: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<MineForResult> {
  const startCargo = holdSpace(account).used;
  const held = () => (itemId ? heldQuantity(account, itemId) : 0);
  const finish = (reason: MineStopReason, error?: Error): MineForResult => ({
    reason,
    held: held(),
    gained: holdSpace(account).used - startCargo,
    error,
  });

  for (;;) {
    if (signal?.aborted) return finish('aborted');
    if (itemId && quantity > 0 && held() >= quantity) return finish('target-met');
    const space = holdSpace(account);
    if (space.free <= 0) return finish('full');
    if (!(account.location?.resources ?? []).some((r) => (r.remaining ?? 0) > 0)) return finish('depleted');

    const before = space.used;
    try {
      await account.commands.spacemolt.mine();
    } catch (error) {
      return finish('error', error instanceof Error ? error : new Error(String(error)));
    }
    if (holdSpace(account).used <= before) return finish('no-yield');
    onProgress?.({ held: held(), cargoUsed: holdSpace(account).used, cargoCapacity: space.capacity });
  }
}

// ---------------------------------------------------------------------------
// The mission frame
// ---------------------------------------------------------------------------

export type MiningMissionReason =
  | 'completed'
  | 'no-mission'
  | 'no-belt'
  | 'not-enough-ore'
  | 'no-route-home'
  /** Down to the last fuel cell — paused so a resupply can be planned. */
  | 'fuel-reserve'
  | 'aborted'
  | 'error';

export interface MiningMissionResult {
  reason: MiningMissionReason;
  title?: string;
  itemId?: string;
  mined: number;
  credits: number;
  error?: Error;
}

/**
 * Accept the best mining mission on the local board, go find the ore, bring it
 * back, and complete.
 *
 * Worth knowing: **`mine_resource` objectives don't consume the ore.** The
 * mission counts what you extracted, and the cargo is still yours afterwards —
 * so a completed mining run pays the reward *and* leaves sellable/refinable
 * stock. Verified live.
 */
export async function runMiningMission(
  account: Account,
  opts: {
    onProgress?: (p: { step: string; detail?: string }) => void;
    signal?: AbortSignal;
    maxJumps?: number;
    exclude?: ReadonlySet<string>;
  } = {},
): Promise<MiningMissionResult> {
  const finish = (reason: MiningMissionReason, extra: Partial<MiningMissionResult> = {}): MiningMissionResult => ({
    reason,
    mined: 0,
    credits: 0,
    ...extra,
  });

  try {
    await ensureDocked(account);
    const homeBaseId = position(account).dockedAt;
    opts.onProgress?.({ step: 'reading-board' });

    const pick = pickMission(await board(account), isMiningMission, capabilities(account), opts.exclude);
    if (!pick) return finish('no-mission');
    const { mission } = pick;

    const objective = (mission.objectives ?? []).find((o) => o.type === 'mine_resource');
    const itemId = objective?.item_id;
    const target = objective ? objectiveTarget(objective) - objectiveProgress(objective) : 0;
    if (!itemId || target <= 0) return finish('no-mission', { title: mission.title });

    if (!isActive(account, mission)) {
      opts.onProgress?.({ step: 'accepting', detail: mission.title });
      await acceptMission(account, mission);
    }

    opts.onProgress?.({ step: 'finding-belt', detail: itemId });
    const belt = await findBelt(account, {
      resourceId: itemId,
      homeBaseId,
      maxJumps: opts.maxJumps ?? 2,
      signal: opts.signal,
      onProgress: opts.onProgress,
    });
    if (!belt.found) return finish(belt.reason === 'aborted' ? 'aborted' : 'no-belt', { title: mission.title, itemId });

    opts.onProgress?.({ step: 'mining', detail: `${target} x ${itemId}` });
    const haul = await mineFor(account, { itemId, quantity: target, signal: opts.signal });

    // Come home on *every* path, not just the happy one.
    //
    // The first version returned home only after a successful haul, so a run
    // that fell short left the pilot parked at the belt — undocked, hold full,
    // fuel spent. Observed live: stopped at 7/20 platinum with 13 fuel and a
    // 50/50 hold, sitting in space. A loop that strands you on failure is worse
    // than one that refuses to start, because failure is the common case: a
    // mixed belt fills the hold with whatever it feels like.
    const goHome = async () => {
      if (!homeBaseId || position(account).dockedAt === homeBaseId) return true;
      opts.onProgress?.({ step: 'returning', detail: homeBaseId });
      const route = await routeTo(account, homeBaseId, { signal: opts.signal });
      if (route.reason !== 'arrived') return false;
      await ensureDocked(account);
      return true;
    };

    if (haul.reason === 'aborted') {
      await goHome();
      return finish('aborted', { title: mission.title, itemId, mined: haul.gained });
    }
    if (haul.held < target) {
      const back = await goHome();
      return finish(back ? 'not-enough-ore' : 'no-route-home', {
        title: mission.title,
        itemId,
        mined: haul.gained,
        error: haul.error,
      });
    }

    if (!(await goHome())) {
      return finish('no-route-home', { title: mission.title, itemId, mined: haul.gained });
    }

    const missionId = activeMissionId(account, mission);
    if (!missionId) return finish('error', { title: mission.title, itemId, mined: haul.gained });

    opts.onProgress?.({ step: 'completing', detail: mission.title });
    await account.commands.spacemolt.complete_mission({ id: missionId });

    return {
      reason: 'completed',
      title: mission.title,
      itemId,
      mined: haul.gained,
      credits: mission.rewards?.credits ?? 0,
    };
  } catch (error) {
    return finish('error', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}
