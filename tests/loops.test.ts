/**
 * Unit tests for the pure selectors behind the gameplay loops.
 *
 * The loops themselves are I/O over a live socket, but every judgement call
 * they make lives in a pure function taking plain data — which is exactly what
 * these cover. Fixtures mirror shapes observed on the live server.
 */

import { expect, test } from 'bun:test';
import type { MarketListingItem, MissionInfo } from '../src/index.ts';
import {
  type Capabilities,
  FUEL_CELL_TIERS,
  feasible,
  findActiveMission,
  hasObjective,
  missionAcceptKey,
  missionStops,
  pickMission,
  planCellBurn,
} from '../examples/loop-primitives.ts';
import { deferSameSystemStops, isTourSatisfiable, planStack } from '../examples/mission-stacking.ts';
import { beltCandidates, mineablePoiTypes, nextSystem } from '../examples/mining-loops.ts';
import { bestBuyer, cheapestSource, unavailable } from '../examples/market-scout.ts';
import { findSpreads, isTradingMission, sellableHere } from '../examples/trading-loops.ts';
import { cheapestRecipe, isCraftingMission } from '../examples/crafting-loops.ts';

// --- helpers ---------------------------------------------------------------

function row(partial: Partial<MarketListingItem> & { item_id: string }): MarketListingItem {
  return {
    item_name: partial.item_id,
    category: 'material',
    sell_orders: [],
    buy_orders: [],
    best_sell: 0,
    best_buy: 0,
    sell_quantity: 0,
    sell_price: 0,
    best_sell_qty: 0,
    buy_quantity: 0,
    buy_price: 0,
    best_buy_qty: 0,
    ...partial,
  };
}

function mission(partial: Partial<MissionInfo>): MissionInfo {
  return { objectives: [], ...partial } as MissionInfo;
}

/** Objectives always carry a description on the wire; tests don't care about it. */
function objective(type: string, quantity?: number): NonNullable<MissionInfo['objectives']>[number] {
  return { type, quantity, description: `${type} x${quantity ?? 0}` };
}

/** A pilot's capability snapshot; defaults to a fresh account with nothing. */
function caps(partial: Partial<Capabilities> = {}): Capabilities {
  return { modules: [], skills: {}, credits: 0, cargoCapacity: 50, hasWeapon: false, ...partial };
}

// --- market selectors ------------------------------------------------------

test('findSpreads ignores items with no ask here', () => {
  // best_sell 0 means nothing is actually for sale, even though buyers bid.
  const here = [row({ item_id: 'steel_plate', best_sell: 0, best_buy: 54 })];
  const there = [row({ item_id: 'steel_plate', best_buy: 90, best_buy_qty: 100 })];
  expect(findSpreads(here, there)).toEqual([]);
});

test('findSpreads requires a real edge', () => {
  const here = [row({ item_id: 'ore', best_sell: 50, best_sell_qty: 10 })];
  const there = [row({ item_id: 'ore', best_buy: 50, best_buy_qty: 10 })]; // equal, not profitable
  expect(findSpreads(here, there)).toEqual([]);
});

test('findSpreads sizes by the thinner book and caps at hold capacity', () => {
  const here = [row({ item_id: 'ore', best_sell: 10, best_sell_qty: 500 })];
  const there = [row({ item_id: 'ore', best_buy: 30, best_buy_qty: 7 })]; // only 7 units of demand

  const [thin] = findSpreads(here, there);
  expect(thin?.quantity).toBe(7); // not 500
  expect(thin?.profit).toBe(140); // (30-10)*7

  const [capped] = findSpreads(here, there, { capacity: 3 });
  expect(capped?.quantity).toBe(3);
  expect(capped?.profit).toBe(60);
});

test('findSpreads ranks by total profit, not unit margin', () => {
  const here = [
    row({ item_id: 'wide', best_sell: 10, best_sell_qty: 100 }),
    row({ item_id: 'rich', best_sell: 10, best_sell_qty: 2 }),
  ];
  const there = [
    row({ item_id: 'wide', best_buy: 15, best_buy_qty: 100 }), // margin 5 x100 = 500
    row({ item_id: 'rich', best_buy: 100, best_buy_qty: 2 }), // margin 90 x2  = 180
  ];
  expect(findSpreads(here, there).map((s) => s.itemId)).toEqual(['wide', 'rich']);
});

test('findSpreads honours minProfit', () => {
  const here = [row({ item_id: 'ore', best_sell: 10, best_sell_qty: 5 })];
  const there = [row({ item_id: 'ore', best_buy: 11, best_buy_qty: 5 })]; // profit 5
  expect(findSpreads(here, there, { minProfit: 100 })).toEqual([]);
});

test('sellableHere skips cargo rows missing an id or quantity', () => {
  const rows = [row({ item_id: 'steel_plate', best_buy: 54, best_buy_qty: 100 })];
  const cargo = [{ item_id: 'steel_plate', quantity: 10 }, { item_id: undefined, quantity: 5 }, { item_id: 'x' }];
  expect(sellableHere(cargo, rows)).toEqual([{ itemId: 'steel_plate', quantity: 10, bid: 54, proceeds: 540 }]);
});

test('sellableHere clamps to available demand', () => {
  const rows = [row({ item_id: 'ore', best_buy: 3, best_buy_qty: 4 })];
  expect(sellableHere([{ item_id: 'ore', quantity: 100 }], rows)[0]?.quantity).toBe(4);
});

// --- mission selectors -----------------------------------------------------

test('feasible gates on installed modules', () => {
  const bounty = mission({ required_modules: ['pulse_laser_i'] });
  expect(feasible(bounty, caps({ modules: ['mining_laser_i'] }))).toBe(false);
  expect(feasible(bounty, caps({ modules: ['mining_laser_i', 'pulse_laser_i'] }))).toBe(true);
  // No requirement means anyone can take it.
  expect(feasible(mission({}), caps())).toBe(true);
});

test('feasible gates on skills the mission data never mentions', () => {
  // MissionInfo carries no skill field at all — the smuggling requirement is
  // only discoverable by attempting to accept. TYPE_SKILL_GATES encodes it.
  const run = mission({ type: 'smuggling', objectives: [objective('deliver_item', 5)] });
  expect(feasible(run, caps())).toBe(false);
  expect(feasible(run, caps({ skills: { smuggling: 1 } }))).toBe(true);
});

test('feasible refuses combat without a weapon', () => {
  // Not a server rule — attempting it just destroys the ship, which for a
  // fresh pilot ends the run.
  const hunt = mission({ objectives: [objective('kill_creature', 6)] });
  expect(feasible(hunt, caps())).toBe(false);
  expect(feasible(hunt, caps({ hasWeapon: true }))).toBe(true);
});

test('pickMission takes the highest reward among feasible matches', () => {
  const missions = [
    mission({ template_id: 'cheap', rewards: { credits: 1000 }, objectives: [objective('sell_item', 10)] }),
    mission({ template_id: 'rich', rewards: { credits: 3500 }, objectives: [objective('sell_item', 10)] }),
  ];
  expect(pickMission(missions, isTradingMission, caps())?.mission.template_id).toBe('rich');
});

test('pickMission skips missions this ship cannot attempt', () => {
  const missions = [
    mission({
      template_id: 'rich-but-armed',
      rewards: { credits: 8000 },
      required_modules: ['pulse_laser_i'],
      objectives: [objective('sell_item', 10)],
    }),
    mission({ template_id: 'modest', rewards: { credits: 1000 }, objectives: [objective('sell_item', 10)] }),
  ];
  expect(pickMission(missions, isTradingMission, caps({ modules: ['mining_laser_i'] }))?.mission.template_id).toBe(
    'modest',
  );
});

test('pickMission returns undefined on an empty board rather than throwing', () => {
  expect(pickMission([], isTradingMission, caps())).toBeUndefined();
});

test('missionAcceptKey prefers template_id, falls back to mission_id for procedural missions', () => {
  // Canned board mission — carries a template_id shared across every instance.
  expect(missionAcceptKey({ template_id: 'workshop_production_run', mission_id: 'workshop_production_run' })).toBe(
    'workshop_production_run',
  );
  // Procedurally-generated mission (e.g. a courier run) has no template_id;
  // its mission_id is already the unique per-offer identifier.
  expect(
    missionAcceptKey({ template_id: undefined, mission_id: 'smuggling_black_frontier_station_hot_cell~abc123' }),
  ).toBe('smuggling_black_frontier_station_hot_cell~abc123');
});

test('findActiveMission matches on either field, not a recomputed shared key', () => {
  // Verified live: a wormhole-intro mission's board listing had no template_id
  // (accepted by mission_id), but its accepted instance carried *both* a
  // template_id and that same mission_id — recomputing the accept-key from
  // the active entry would prefer its template_id and miss the match.
  const active = [{ mission_id: 'wh_intro_outerrim_e234e42c', template_id: 'wormhole_intro_outerrim' }];
  expect(findActiveMission(active, 'wh_intro_outerrim_e234e42c')?.mission_id).toBe('wh_intro_outerrim_e234e42c');

  // Canned mission: matched by template_id, resolves to the freshly-minted
  // per-instance mission_id (a different string from the template).
  const canned = [{ mission_id: 'a1b2c3', template_id: 'workshop_production_run' }];
  expect(findActiveMission(canned, 'workshop_production_run')?.mission_id).toBe('a1b2c3');

  expect(findActiveMission([], 'nonexistent')).toBeUndefined();
});

test('mission classifiers match on objective type', () => {
  const trade = mission({ objectives: [objective('deliver_item', 5)] });
  const craft = mission({ objectives: [objective('craft_item', 5)] });
  const mine = mission({ objectives: [objective('mine_resource', 20)] });

  expect(isTradingMission(trade)).toBe(true);
  expect(isTradingMission(craft)).toBe(false);
  expect(isCraftingMission(craft)).toBe(true);
  expect(isCraftingMission(mine)).toBe(false);
  expect(hasObjective(mine, 'mine_resource')).toBe(true);
});

// --- crafting selectors ----------------------------------------------------

test('cheapestRecipe prefers fewer inputs per output', () => {
  // Observed live: basic_iron_smelting is 10 ore -> 1 plate; refine_steel is
  // 5 ore -> 2 plates, i.e. 2.5 ore per plate.
  const best = cheapestRecipe([
    { recipeId: 'basic_iron_smelting', inputsPerOutput: 10 },
    { recipeId: 'refine_steel', inputsPerOutput: 2.5 },
  ]);
  expect(best?.recipeId).toBe('refine_steel');
});

test('cheapestRecipe returns undefined with no options', () => {
  expect(cheapestRecipe([])).toBeUndefined();
});

// --- mission geography + stacking ------------------------------------------

test('missionStops extracts only objectives that imply travel', () => {
  const m = mission({
    objectives: [
      { type: 'dock_at_base', target_base_id: 'ramens_rest', description: 'dock' },
      { type: 'visit_system', system_id: 'first_step', description: 'visit' },
      { type: 'craft_item', quantity: 5, description: 'craft' }, // local — no stop
    ],
  });
  expect(missionStops(m)).toEqual([
    { kind: 'base', id: 'ramens_rest' },
    { kind: 'system', id: 'first_step' },
  ]);
});

test('missionStops de-duplicates repeated destinations', () => {
  const m = mission({
    objectives: [
      { type: 'dock_at_base', target_base_id: 'void_gate_outpost', description: 'a' },
      { type: 'dock_at_base', target_base_id: 'void_gate_outpost', description: 'b' },
    ],
  });
  expect(missionStops(m)).toHaveLength(1);
});

/** The live board that produced the 33,300cr circuit, in miniature. */
function tourBoard(): MissionInfo[] {
  const dock = (id: string) => ({ type: 'dock_at_base', target_base_id: id, description: `dock ${id}` });
  return [
    mission({
      template_id: 'frontier_wayfinder_circuit',
      rewards: { credits: 20000 },
      objectives: [dock('deep_range_outpost'), dock('ramens_rest'), dock('void_gate_outpost')],
    }),
    mission({ template_id: 'the_memorial', rewards: { credits: 8000 }, objectives: [dock('deep_range_outpost')] }),
    mission({ template_id: 'debris_field_reports', rewards: { credits: 4500 }, objectives: [dock('ramens_rest')] }),
    mission({ template_id: 'the_proposal', rewards: { credits: 800 }, objectives: [dock('void_gate_outpost')] }),
  ];
}

test('planStack bundles free riders whose stops the anchor already covers', () => {
  const stack = planStack(tourBoard(), caps());
  // All four, for no extra travel beyond the anchor's three stops.
  expect(stack?.missions).toHaveLength(4);
  expect(stack?.stops).toHaveLength(3);
  expect(stack?.credits).toBe(33300);
  expect(stack?.creditsPerStop).toBe(11100);
});

test('planStack anchors on the highest reward', () => {
  expect(planStack(tourBoard(), caps())?.missions[0]?.template_id).toBe('frontier_wayfinder_circuit');
});

test('planStack excludes missions adding new stops unless allowed', () => {
  const board = [
    ...tourBoard(),
    mission({
      template_id: 'far_detour',
      rewards: { credits: 9000 },
      objectives: [{ type: 'dock_at_base', target_base_id: 'somewhere_else', description: 'far' }],
    }),
  ];
  expect(planStack(board, caps())?.missions.map((m) => m.template_id)).not.toContain('far_detour');
  // One extra stop permitted -> it comes along.
  const loose = planStack(board, caps(), { allowExtraStops: 1 });
  expect(loose?.missions.map((m) => m.template_id)).toContain('far_detour');
  expect(loose?.stops).toHaveLength(4);
});

test('planStack respects maxStops and exclusions', () => {
  expect(planStack(tourBoard(), caps(), { maxStops: 2 })).toBeUndefined(); // anchor alone needs 3
  const skipped = planStack(tourBoard(), caps(), { exclude: new Set(['frontier_wayfinder_circuit']) });
  expect(skipped?.missions[0]?.template_id).toBe('the_memorial');
});

test('planStack skips missions the pilot cannot attempt', () => {
  const board = [
    mission({
      template_id: 'armed_only',
      rewards: { credits: 50000 },
      objectives: [objective('kill_creature', 3)],
    }),
    ...tourBoard(),
  ];
  // Unarmed: the 50,000cr bounty is not an option, so the tour anchors instead.
  expect(planStack(board, caps())?.missions[0]?.template_id).toBe('frontier_wayfinder_circuit');
});

test('planStack returns undefined when nothing is eligible', () => {
  expect(planStack([], caps())).toBeUndefined();
  // Zero-reward ambient missions don't anchor a circuit.
  expect(planStack([mission({ template_id: 'free', rewards: { credits: 0 } })], caps())).toBeUndefined();
});

// --- mining selectors ------------------------------------------------------

test('mineablePoiTypes follows fitted harvesters', () => {
  expect(mineablePoiTypes(caps({ modules: ['mining_laser_i'] }))).toEqual(['asteroid_belt']);
  expect(mineablePoiTypes(caps({ modules: [] }))).toEqual([]);
  expect(mineablePoiTypes(caps({ modules: ['mining_laser_i', 'ice_harvester_i'] })).sort()).toEqual([
    'asteroid_belt',
    'ice_field',
  ]);
});

test('beltCandidates keeps only POIs we can actually work', () => {
  // Horizon's real POI list: no belt at all.
  const horizon = [
    { id: 'theta_minor_star', type: 'sun' },
    { id: 'theta_minor_i', type: 'planet' },
    { id: 'horizon_phase_drift', type: 'nebula' },
    { id: 'mobile_capital', type: 'station' },
  ];
  expect(beltCandidates(horizon, ['asteroid_belt'])).toEqual([]);

  const withBelt = [...horizon, { id: 'colony_debris_field', type: 'asteroid_belt' }];
  expect(beltCandidates(withBelt, ['asteroid_belt']).map((p) => p.id)).toEqual(['colony_debris_field']);
  // A gas cloud is scenery without a gas harvester.
  expect(beltCandidates([{ id: 'g', type: 'gas_cloud' }], ['asteroid_belt'])).toEqual([]);
});

test('isTourSatisfiable accepts travel-only missions, rejects ones needing work', () => {
  const travel = mission({
    objectives: [{ type: 'dock_at_base', target_base_id: 'x', description: 'd' }],
  });
  const mine = mission({ objectives: [objective('mine_resource', 20)] });
  const mixed = mission({
    objectives: [{ type: 'dock_at_base', target_base_id: 'x', description: 'd' }, objective('craft_item', 5)],
  });
  expect(isTourSatisfiable(travel)).toBe(true);
  expect(isTourSatisfiable(mine)).toBe(false); // adds no stops, but the tour never mines
  expect(isTourSatisfiable(mixed)).toBe(false);
  expect(isTourSatisfiable(mission({ objectives: [] }))).toBe(false);
});

test('planStack will not bundle work the tour cannot do', () => {
  // A mining mission names no destination, so it looks like a free rider by
  // stop-count alone — but the tour only travels, so it would be accepted and
  // then sit unfinished, burning one of five slots.
  const board = [
    ...tourBoard(),
    mission({ template_id: 'iron_run', rewards: { credits: 9999 }, objectives: [objective('mine_resource', 30)] }),
  ];
  const stack = planStack(board, caps());
  expect(stack?.missions.map((m) => m.template_id)).not.toContain('iron_run');
});

test('planStack respects the 5-mission server cap by default', () => {
  const dock = (id: string) => ({ type: 'dock_at_base', target_base_id: id, description: `dock ${id}` });
  const anchor = mission({
    template_id: 'anchor',
    rewards: { credits: 20000 },
    objectives: [dock('a'), dock('b'), dock('c')],
  });
  // Eight riders, all free — but only four can fit alongside the anchor.
  const riders = Array.from({ length: 8 }, (_, i) =>
    mission({ template_id: `rider${i}`, rewards: { credits: 100 - i }, objectives: [dock('a')] }),
  );
  expect(planStack([anchor, ...riders], caps())?.missions).toHaveLength(5);
  expect(planStack([anchor, ...riders], caps(), { maxMissions: 2 })?.missions).toHaveLength(2);
});

test('planStack drops missions with an unreachable stop, however well they pay', () => {
  const dock = (id: string) => ({ type: 'dock_at_base', target_base_id: id, description: `dock ${id}` });
  const board = [
    // Reachable but not returnable — the live `the_crucible` case.
    mission({ template_id: 'far', rewards: { credits: 99999 }, objectives: [dock('the_crucible')] }),
    mission({ template_id: 'near', rewards: { credits: 800 }, objectives: [dock('deep_range_outpost')] }),
  ];
  const stopAllowed = (s: { id: string }) => s.id !== 'the_crucible';
  const stack = planStack(board, caps(), { stopAllowed });
  expect(stack?.missions.map((m) => m.template_id)).toEqual(['near']);
});

test('deferSameSystemStops holds back a system we are already sitting in', () => {
  // routeTo no-ops when you're already there, and standing still does not
  // count as a visit — so it must be arrived at on the way home instead.
  const stops = [
    { kind: 'system' as const, id: 'horizon' },
    { kind: 'system' as const, id: 'sirius' },
    { kind: 'base' as const, id: 'frontier_station' },
  ];
  const { remaining, deferred } = deferSameSystemStops(stops, 'horizon');
  expect(deferred).toEqual([{ kind: 'system', id: 'horizon' }]);
  expect(remaining.map((s) => s.id)).toEqual(['sirius', 'frontier_station']);
});

test('deferSameSystemStops leaves base stops alone and handles unknown position', () => {
  // A base in the current system still needs travel + dock, so it is real work.
  const stops = [
    { kind: 'base' as const, id: 'mobile_capital' },
    { kind: 'system' as const, id: 'sirius' },
  ];
  expect(deferSameSystemStops(stops, 'horizon').deferred).toEqual([]);
  expect(deferSameSystemStops(stops, undefined).remaining).toHaveLength(2);
});

// --- fuel cells ------------------------------------------------------------

function stock(byTier: Record<string, number>) {
  const count = Object.values(byTier).reduce((a, b) => a + b, 0);
  const potential = Object.entries(byTier).reduce(
    (sum, [id, n]) => sum + n * (FUEL_CELL_TIERS.find((t) => t.itemId === id)?.restores ?? 0),
    0,
  );
  return { byTier, count, potential };
}

test('planCellBurn prefers the smallest cell that closes the gap', () => {
  // 20 units short with all three tiers on board: burning a military cell
  // would throw away 80 units, so take the standard one.
  const s = stock({ fuel_cell: 2, premium_fuel_cell: 2, military_fuel_cell: 2 });
  expect(planCellBurn(20, s)).toEqual([{ itemId: 'fuel_cell', count: 1 }]);
  expect(planCellBurn(45, s)).toEqual([{ itemId: 'premium_fuel_cell', count: 1 }]);
  expect(planCellBurn(90, s)).toEqual([{ itemId: 'military_fuel_cell', count: 1 }]);
});

test('planCellBurn falls back to the largest available when nothing covers the gap', () => {
  const s = stock({ fuel_cell: 3 });
  // 50 needed, 20 per cell, keeping 1 in reserve -> only 2 burnable.
  expect(planCellBurn(50, s)).toEqual([{ itemId: 'fuel_cell', count: 2 }]);
});

test('planCellBurn never spends the reserve', () => {
  expect(planCellBurn(100, stock({ fuel_cell: 1 }))).toEqual([]);
  // Explicitly opting out of the reserve is how a resupply run gets fuel.
  expect(planCellBurn(100, stock({ fuel_cell: 1 }), 0)).toEqual([{ itemId: 'fuel_cell', count: 1 }]);
});

test('planCellBurn returns nothing when there is no deficit or no stock', () => {
  expect(planCellBurn(0, stock({ fuel_cell: 5 }))).toEqual([]);
  expect(planCellBurn(50, stock({}))).toEqual([]);
});

test('planCellBurn combines tiers when one is not enough', () => {
  // 140 needed: military (100) closes most, then a premium (50) for the rest.
  const s = stock({ premium_fuel_cell: 1, military_fuel_cell: 1 });
  const plan = planCellBurn(140, s, 0);
  expect(plan).toContainEqual({ itemId: 'military_fuel_cell', count: 1 });
  expect(plan).toContainEqual({ itemId: 'premium_fuel_cell', count: 1 });
});

// --- market scouting -------------------------------------------------------

function quote(stationId: string, itemId: string, ask: number, bid = 0, askQty = 99, bidQty = 99) {
  return { stationId, systemId: 's', itemId, ask, askQty, bid, bidQty };
}

test('cheapestSource ignores stations with nothing for sale', () => {
  // ask 0 means no seller, not "free" — the distinction matters because 0
  // sorts first if you forget to filter.
  const quotes = [quote('a', 'gas_harvester_i', 0), quote('b', 'gas_harvester_i', 1400)];
  expect(cheapestSource(quotes, 'gas_harvester_i')?.stationId).toBe('b');
});

test('cheapestSource respects the quantity we need', () => {
  const quotes = [quote('cheap', 'flex_polymer', 40, 0, 2), quote('deep', 'flex_polymer', 50, 0, 60)];
  expect(cheapestSource(quotes, 'flex_polymer', 1)?.stationId).toBe('cheap');
  expect(cheapestSource(quotes, 'flex_polymer', 10)?.stationId).toBe('deep');
  expect(cheapestSource(quotes, 'flex_polymer', 500)).toBeUndefined();
});

test('bestBuyer picks the highest bid with enough depth', () => {
  const quotes = [quote('a', 'steel_plate', 0, 54, 0, 5000), quote('b', 'steel_plate', 0, 90, 0, 2)];
  expect(bestBuyer(quotes, 'steel_plate')?.stationId).toBe('b');
  // A 90cr bid for 2 units is no use when unloading 20.
  expect(bestBuyer(quotes, 'steel_plate', 20)?.stationId).toBe('a');
});

test('unavailable reports watchlist items nobody sells', () => {
  const quotes = [quote('a', 'circuit_board', 0), quote('a', 'flex_polymer', 50)];
  expect(unavailable(quotes, ['circuit_board', 'flex_polymer'])).toEqual(['circuit_board']);
});

test('nextSystem prefers known leads over blind neighbours', () => {
  const visited = new Set(['here']);
  // The lead wins even though it is not adjacent — routeTo can multi-hop, and a
  // known-good destination beats an unknown one next door.
  expect(nextSystem(['altais', 'distant_light'], visited, ['frontier'])).toBe('frontier');
  // Already-tried leads are skipped rather than looped on.
  expect(nextSystem(['altais'], new Set(['frontier']), ['frontier'])).toBe('altais');
  // No leads, no unvisited neighbours -> give up rather than revisit.
  expect(nextSystem(['altais'], new Set(['altais']), [])).toBeUndefined();
});
