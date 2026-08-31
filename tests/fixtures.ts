/**
 * Fixture builders for the spec's game-state shapes.
 *
 * The server sends complete sections — every field the spec marks `required`
 * is present on the wire — so an honest mock has to be complete too. Spelling
 * out 29 ship fields at each call site would bury what a test is actually
 * asserting, so each builder fills the required fields with inert defaults and
 * takes an override patch for the handful a test cares about. When the spec
 * later adds a field to a `required` list, that costs one default here instead
 * of an edit at every fixture site.
 */

import type { MapSystem } from '../src/data/map.ts';
import type {
  SkillProgress,
  V2CargoItem,
  V2GameState,
  V2Location,
  V2NearbyPlayer,
  V2Personnel,
  V2Player,
  V2Queue,
  V2Resource,
  V2Ship,
} from '../src/generated/openapi/types.gen.ts';

export function personnel(overrides: Partial<V2Personnel> = {}): V2Personnel {
  return { fit_crew: 0, injured_crew: 0, fit_marines: 0, injured_marines: 0, ...overrides };
}

export function player(overrides: Partial<V2Player> = {}): V2Player {
  return {
    id: 'player_1',
    username: 'Nova',
    empire: 'confederacy',
    credits: 5000,
    status_message: '',
    clan_tag: '',
    primary_color: '',
    secondary_color: '',
    is_cloaked: false,
    home_base: '',
    stats: {},
    ...overrides,
  };
}

export function ship(overrides: Partial<V2Ship> = {}): V2Ship {
  return {
    id: 'ship_1',
    class_id: 'shuttle',
    class_name: 'Shuttle',
    name: 'Nova I',
    hull: 100,
    max_hull: 100,
    shield: 50,
    max_shield: 50,
    shield_recharge: 1,
    armor: 0,
    speed: 10,
    fuel: 100,
    max_fuel: 100,
    cargo_used: 0,
    cargo_capacity: 50,
    cpu_used: 0,
    cpu_capacity: 100,
    power_used: 0,
    power_capacity: 100,
    weapon_slots: 1,
    defense_slots: 1,
    utility_slots: 1,
    personnel: personnel(),
    effective_crew_capacity: 1,
    minimum_crew: 1,
    effective_marine_capacity: 0,
    crew_efficiency: 1,
    operational_speed: 10,
    incapacitated: false,
    ...overrides,
  };
}

export function nearbyPlayer(overrides: Partial<V2NearbyPlayer> = {}): V2NearbyPlayer {
  return { player_id: 'other_1', in_combat: false, ...overrides };
}

export function resource(overrides: Partial<V2Resource> = {}): V2Resource {
  return { item_id: 'iron_ore', item_name: 'Iron Ore', richness: 1, remaining: 100, ...overrides };
}

export function cargoItem(overrides: Partial<V2CargoItem> = {}): V2CargoItem {
  return { item_id: 'iron_ore', item_name: 'Iron Ore', quantity: 10, size: 1, ...overrides };
}

export function skill(overrides: Partial<SkillProgress> = {}): SkillProgress {
  return { name: 'Mining', category: 'industry', level: 1, max_level: 5, xp: 0, next_level_xp: 100, ...overrides };
}

export function queue(overrides: Partial<V2Queue> = {}): V2Queue {
  return { has_pending: false, ...overrides };
}

/**
 * `docked_at` is required and non-nullable in the spec, but the server sends
 * `null` when undocked (see docs/gameserver-todo.md). The empty string stands
 * in for "not docked" here so fixtures stay type-clean; tests that care about
 * docking set it explicitly.
 */
export function location(overrides: Partial<V2Location> = {}): V2Location {
  return {
    system_id: 'sol',
    system_name: 'Sol',
    empire: 'confederacy',
    security_status: 'core',
    connections: ['alpha_centauri'],
    poi_id: 'earth_station',
    poi_name: 'Earth Station',
    poi_type: 'station',
    docked_at: '',
    resources: [],
    nearby_players: [],
    nearby_player_count: 0,
    nearby_prizes: [],
    nearby_prize_count: 0,
    nearby_pirates: [],
    nearby_pirate_count: 0,
    nearby_empire_npcs: [],
    nearby_empire_npc_count: 0,
    ...overrides,
  };
}

export function gameState(overrides: Partial<V2GameState> = {}): V2GameState {
  return {
    player: player(),
    ship: ship(),
    location: location(),
    cargo: [cargoItem()],
    skills: { mining: skill({ name: 'Mining', level: 3 }) },
    queue: queue(),
    ...overrides,
  };
}

/** A complete `/api/map` system entry. */
export function mapSystem(overrides: Partial<MapSystem> = {}): MapSystem {
  return {
    id: 'sol',
    name: 'Sol',
    x: 0,
    y: 0,
    online: 0,
    connections: [],
    ...overrides,
  };
}
