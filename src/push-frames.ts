/**
 * Hand-written payload types for the `ok` and `fleet` push frames.
 *
 * Every other push frame is typed from the server's published
 * `Notification_<msg_type>` schema, and the generated `NotificationPayloads`
 * map carries it. These two families publish no schema at all — neither
 * appears in the spec's notification union — so without this file they reach a
 * consumer as `Record<string, unknown>`.
 *
 * They are hand-written rather than published because splitting them into
 * distinct `msg_type`s is the fix, and that breaks any v1 client switching on
 * `type === "ok"`. Until v1 is retired the shapes live here.
 * `tests/push-frames.test.ts` fails the moment the server does publish either
 * schema, which is the signal to delete this file and let codegen take over.
 *
 * Derived from gameserver v0.596.2. A frame the server adds after that reaches
 * `onAny` but is not in these unions — they are deliberately closed, because a
 * union with an open `{ action: string }` member narrows to nothing useful.
 */

import type { JumpResponse, TravelResponse } from './generated/openapi/types.gen.ts';

/** Fields every `ok` and `fleet` push carries. */
interface PushBase {
  /** Human-readable summary. Present on most, absent on the movement pushes. */
  message?: string;
}

// --- `ok` pushes discriminated by `action` -----------------------------------

/** Your own transit started. The state cache applies this automatically. */
export interface OkTravelStarted extends PushBase {
  action: 'travel';
  /** POI ID being travelled to. */
  destination: string;
  /** Engine tick the arrival lands on. */
  arrival_tick: number;
}

/** Your own jump started. The state cache applies this automatically. */
export interface OkJumpStarted extends PushBase {
  action: 'jump';
  /** System ID being jumped to. */
  destination: string;
  arrival_tick: number;
  /** True when the jump routes through a wormhole rather than a lane. */
  is_wormhole: boolean;
}

/** Your fleet leader started an in-system travel and pulled you along. */
export interface OkFleetTravelStarted extends PushBase {
  action: 'fleet_travel';
  destination: string;
  arrival_tick: number;
}

/** Your fleet leader started a jump and pulled you along. */
export interface OkFleetJumpStarted extends PushBase {
  action: 'fleet_jump';
  destination: string;
  arrival_tick: number;
}

/** Your fleet leader docked and took the fleet with them. */
export interface OkFleetDocked extends PushBase {
  action: 'fleet_dock';
  /** Station display name. */
  base: string;
  /** Canonical base ID — this is what `location.docked_at` holds, not `base`. */
  base_id: string;
}

/** Your fleet leader undocked and took the fleet with them. */
export interface OkFleetUndocked extends PushBase {
  action: 'fleet_undock';
}

/**
 * The ship you were riding was destroyed or captured. You are at your home
 * station with no ship. A `player_died`-style state delta follows on a v2
 * socket; `riding` is not a state section, so clear any cached value yourself.
 */
export interface OkPassengerStranded extends PushBase {
  action: 'passenger_stranded';
}

/** An espionage operation you launched is under way. */
export interface OkEspionage extends PushBase {
  action: 'espionage';
  arrival_tick: number;
}

/** The Mobile Capital jumped while you were docked at it, taking you along. */
export interface OkMobileCapitalTransit extends PushBase {
  action: 'mobile_capital_transit';
  /** System ID the station arrived in. */
  system: string;
}

/** In-system travel completed. Reuses the generated response schema. */
export type OkArrived = TravelResponse & { action: 'arrived' };

/**
 * A jump or Pathfinder drift completed. Reuses the generated response schema.
 * `pathfinder_arrival` is the off-network variant.
 */
export type OkJumped = JumpResponse & { action: 'jumped' | 'pathfinder_arrival' };

// --- `ok` pushes discriminated by `type` -------------------------------------
// The server uses `type` rather than `action` for these. Narrow on the right
// key: a payload carrying `action` never carries `type`, and vice versa.

/** The server docked you so a dock-required command could run. */
export interface OkAutoDock extends PushBase {
  type: 'auto_dock';
}

/** The server undocked you so a command needing open space could run. */
export interface OkAutoUndock extends PushBase {
  type: 'auto_undock';
}

/** An Emergency Warp Stabilizer fired at critical hull and warped you home. */
export interface OkEmergencyWarpStabilizer extends PushBase {
  type: 'emergency_warp_stabilizer_activated';
  /** Home station display name — not a base ID. */
  home_base: string;
  hull: number;
  max_hull: number;
}

/** Passengers you were carrying reached their destination. */
export interface OkPassengerArrivals extends PushBase {
  type: 'passenger_arrivals';
  station: string;
  delivered: number;
  stranded: number;
  fare_collected: number;
  /** Reputation change per counterparty, keyed by empire or stronghold ID. */
  reputation_changes: Record<string, number>;
}

/** A ship-processing job at a station finished. */
export interface OkShipProcessing extends PushBase {
  type: 'ship_processing';
}

/** Passengers are waiting in a transit lounge you can pick up from. */
export interface OkTransitLoungeDepartures extends PushBase {
  type: 'transit_lounge_departures';
  station: string;
  base_id: string;
  passengers: number;
  /** Ticks until the soonest departure. */
  soonest_ticks: number;
}

/** A new forum thread was posted. Broadcast to every connected player. */
export interface OkNewForumPost extends PushBase {
  type: 'new_forum_post';
  thread_id: string;
  title: string;
  author: string;
  category: string;
  timestamp: string;
  is_dev_team: boolean;
}

// --- `fleet` pushes ----------------------------------------------------------

/** You were invited to a fleet. */
export interface FleetInvite extends PushBase {
  action: 'fleet_invite';
  fleet_id: string;
  leader_name: string;
  leader_id: string;
  /** True for a fleet auto-created to carry an arena challenge. */
  arena_only: boolean;
}

/** The leader removed you from the fleet. */
export interface FleetKicked extends PushBase {
  action: 'fleet_kicked';
}

/** The fleet was disbanded. */
export interface FleetDisbanded extends PushBase {
  action: 'fleet_disbanded';
}

/** Fleet leadership passed to another member. */
export interface FleetLeaderPromoted extends PushBase {
  action: 'fleet_leader_promoted';
  new_leader: string;
}

/** A fleet member died. */
export interface FleetMemberDied extends PushBase {
  action: 'fleet_member_died';
  player_name: string;
}

/** A passenger boarded a fleet ship. */
export interface FleetPassengerBoarded extends PushBase {
  action: 'fleet_passenger_boarded';
  player_id: string;
  player_name: string;
}

// --- unions ------------------------------------------------------------------

/** Every `ok` push the server sends, discriminated by `action` or `type`. */
export type OkPush =
  | OkTravelStarted
  | OkJumpStarted
  | OkFleetTravelStarted
  | OkFleetJumpStarted
  | OkFleetDocked
  | OkFleetUndocked
  | OkPassengerStranded
  | OkEspionage
  | OkMobileCapitalTransit
  | OkArrived
  | OkJumped
  | OkAutoDock
  | OkAutoUndock
  | OkEmergencyWarpStabilizer
  | OkPassengerArrivals
  | OkShipProcessing
  | OkTransitLoungeDepartures
  | OkNewForumPost;

/** Every `fleet` push the server sends, discriminated by `action`. */
export type FleetPush =
  | FleetInvite
  | FleetKicked
  | FleetDisbanded
  | FleetLeaderPromoted
  | FleetMemberDied
  | FleetPassengerBoarded;

/** `action` values carried by an `ok` push. */
export const OK_PUSH_ACTIONS = [
  'travel',
  'jump',
  'fleet_travel',
  'fleet_jump',
  'fleet_dock',
  'fleet_undock',
  'passenger_stranded',
  'espionage',
  'mobile_capital_transit',
  'arrived',
  'jumped',
  'pathfinder_arrival',
] as const;

/** `type` values carried by an `ok` push, for the frames that use that key. */
export const OK_PUSH_TYPES = [
  'auto_dock',
  'auto_undock',
  'emergency_warp_stabilizer_activated',
  'passenger_arrivals',
  'ship_processing',
  'transit_lounge_departures',
  'new_forum_post',
] as const;

/** `action` values carried by a `fleet` push. */
export const FLEET_PUSH_ACTIONS = [
  'fleet_invite',
  'fleet_kicked',
  'fleet_disbanded',
  'fleet_leader_promoted',
  'fleet_member_died',
  'fleet_passenger_boarded',
] as const;
