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
 * **Two discriminators.** Most `ok` variants key on `action`; seven key on
 * `type` instead. That split is the server's, not ours, so a bare `p.action`
 * does not compile on `OkPush` — guard with `'action' in p` first, or narrow to
 * `OkActionPush` / `OkTypePush`. `FleetPush` has a single key and needs no guard.
 *
 * **The unions are closed**, derived from gameserver v0.596.2. A member typed
 * `{ action: string }` to absorb later frames would join every literal's
 * narrowing and make all of them useless. The cost is that a variant the server
 * adds after that build still arrives at your `on('ok')` handler — nothing
 * validates the payload against these types — as a value matching no member. An
 * exhaustive `switch` with a `never` default therefore compiles but is unsafe at
 * runtime; give it a real default branch.
 */

import type {
  AttackNpcResponse,
  AttackPlayerResponse,
  DockResponse,
  EspionageResponse,
  JumpResponse,
  PathfinderJumpResponse,
  TravelResponse,
} from './generated/openapi/types.gen.ts';

/** Human-readable summary, carried by the hand-written variants below. */
interface PushBase {
  message?: string;
}

// --- `ok` pushes discriminated by `action` -----------------------------------

/** Your own transit started. `applyMovementPush` applies this to the cache. */
export interface OkTravelStarted extends PushBase {
  action: 'travel';
  /** POI ID being travelled to. */
  destination: string;
  /** Engine tick the arrival lands on. */
  arrival_tick: number;
}

/** Your own jump started. `applyMovementPush` applies this to the cache. */
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
 * station with no ship. A state delta follows on a v2 socket; `riding` is not a
 * state section, so clear any cached value yourself.
 */
export interface OkPassengerStranded extends PushBase {
  action: 'passenger_stranded';
}

/** The Mobile Capital jumped while you were docked at it, taking you along. */
export interface OkMobileCapitalTransit extends PushBase {
  action: 'mobile_capital_transit';
  /** System ID the station arrived in. */
  system: string;
}

/**
 * An espionage operation you launched is under way (start) or resolved
 * (outcome). The two shapes differ: the start carries `arrival_tick`, the
 * resolution carries `outcome` and `story`. Only the start reaches a v2 socket
 * — the resolution ships as a delta-carrying `action_result` — but both are
 * here because a v1 transport sees both.
 */
export type OkEspionage =
  | (PushBase & { action: 'espionage'; arrival_tick: number })
  | (EspionageResponse & { action: 'espionage' });

/**
 * In-system travel completed.
 *
 * v1 transports only. Over `/ws/v2` an arrival is a delta-carrying
 * `action_result`; this plain broadcast is the fallback taken when no delta
 * sections are set. A v2 consumer's `arrived` handler never fires — read
 * `account.location` instead.
 */
export type OkArrived = TravelResponse & { action: 'arrived' };

/**
 * A jump or Pathfinder drift completed. `pathfinder_arrival` is the off-network
 * variant. v1 transports only, for the same reason as `OkArrived`.
 */
export type OkJumped = JumpResponse;

/** Docking completed. */
export type OkDocked = DockResponse & { action: 'dock' };

/**
 * An attack resolved. Two shapes share the action and are separated by `kind`:
 * `npc` covers pirates, wildlife, stations and prize hulls; `player` is PvP.
 */
export type OkAttack = AttackNpcResponse | AttackPlayerResponse;

/** A Pathfinder off-network jump was plotted, or an in-flight drift replotted. */
export type OkPathfinderPlot = PathfinderJumpResponse;

// --- `ok` pushes discriminated by `type` -------------------------------------
// The server uses `type` rather than `action` for these. A payload carrying
// `action` never carries `type`, and vice versa.

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
  /**
   * Reputation change per counterparty, keyed by empire or stronghold ID. The
   * key is always present, but the value is `null` when the delivery moved no
   * reputation — the common case. Check before iterating.
   */
  reputation_changes: Record<string, number> | null;
}

/** Another player moved connecting passengers onto one of your ships. */
export interface OkPassengersTransferred extends PushBase {
  type: 'passengers_transferred';
  /** ID of your ship the passengers were moved onto. */
  ship_id: string;
  count: number;
  /** Station display name. */
  station: string;
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

/** A shipment you contracted for is past its delivery window. */
export interface OkShipmentOverdue extends PushBase {
  type: 'shipment_overdue';
  shipment_id: string;
  package_id: string;
  /** Base ID the shipment is bound for. */
  destination: string;
  /** Ticks left before the shipment is recovered. */
  recovery_ticks: number;
  late_fee: number;
}

/** A new forum thread was posted. Broadcast to every connected player. */
export interface OkNewForumPost extends PushBase {
  type: 'new_forum_post';
  thread_id: string;
  title: string;
  author: string;
  category: string;
  /** RFC3339 timestamp. */
  timestamp: string;
  is_dev_team: boolean;
}

/**
 * A wildlife kill notice, sent when a hunt lands. Carries neither `action` nor
 * `type` — the optional-undefined keys are what let the other members stay
 * narrowable alongside it.
 */
export interface OkMessageOnly {
  action?: undefined;
  type?: undefined;
  message: string;
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

/** Someone joined the fleet. Sent to every other member. */
export interface FleetMemberJoined {
  action: 'fleet_member_joined';
  player_id: string;
  player_name: string;
}

/** Someone left the fleet. Sent to every other member. */
export interface FleetMemberLeft {
  action: 'fleet_member_left';
  player_id: string;
  player_name: string;
}

/** The leader removed someone. Sent to the remaining members, not the target. */
export interface FleetMemberKicked {
  action: 'fleet_member_kicked';
  player_id: string;
  player_name: string;
}

/** The leader removed *you* from the fleet. */
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

/** A passenger stopped riding and left the fleet. */
export interface FleetPassengerDisembarked extends PushBase {
  action: 'fleet_passenger_disembarked';
  player_id: string;
  player_name: string;
}

// --- unions ------------------------------------------------------------------

/** Every `ok` push known as of gameserver v0.596.2. */
export type OkPush =
  | OkTravelStarted
  | OkJumpStarted
  | OkFleetTravelStarted
  | OkFleetJumpStarted
  | OkFleetDocked
  | OkFleetUndocked
  | OkPassengerStranded
  | OkMobileCapitalTransit
  | OkEspionage
  | OkArrived
  | OkJumped
  | OkDocked
  | OkAttack
  | OkPathfinderPlot
  | OkAutoDock
  | OkAutoUndock
  | OkEmergencyWarpStabilizer
  | OkPassengerArrivals
  | OkPassengersTransferred
  | OkShipProcessing
  | OkTransitLoungeDepartures
  | OkShipmentOverdue
  | OkNewForumPost
  | OkMessageOnly;

/** The `ok` variants keyed on `action`. `Extract`ed for an exhaustive switch. */
export type OkActionPush = Extract<OkPush, { action: string }>;

/** The `ok` variants keyed on `type`. `Extract`ed for an exhaustive switch. */
export type OkTypePush = Extract<OkPush, { type: string }>;

/** Every `fleet` push known as of gameserver v0.596.2, all keyed on `action`. */
export type FleetPush =
  | FleetInvite
  | FleetMemberJoined
  | FleetMemberLeft
  | FleetMemberKicked
  | FleetKicked
  | FleetDisbanded
  | FleetLeaderPromoted
  | FleetMemberDied
  | FleetPassengerBoarded
  | FleetPassengerDisembarked;

/** `action` values carried by an `ok` push. */
export const OK_PUSH_ACTIONS = [
  'travel',
  'jump',
  'fleet_travel',
  'fleet_jump',
  'fleet_dock',
  'fleet_undock',
  'passenger_stranded',
  'mobile_capital_transit',
  'espionage',
  'arrived',
  'jumped',
  'pathfinder_arrival',
  'dock',
  'attack',
  'pathfinder_jump',
  'pathfinder_redirect',
] as const;
export type OkPushAction = (typeof OK_PUSH_ACTIONS)[number];

/** `type` values carried by an `ok` push, for the frames that use that key. */
export const OK_PUSH_TYPES = [
  'auto_dock',
  'auto_undock',
  'emergency_warp_stabilizer_activated',
  'passenger_arrivals',
  'passengers_transferred',
  'ship_processing',
  'transit_lounge_departures',
  'shipment_overdue',
  'new_forum_post',
] as const;
export type OkPushType = (typeof OK_PUSH_TYPES)[number];

/** `action` values carried by a `fleet` push. */
export const FLEET_PUSH_ACTIONS = [
  'fleet_invite',
  'fleet_member_joined',
  'fleet_member_left',
  'fleet_member_kicked',
  'fleet_kicked',
  'fleet_disbanded',
  'fleet_leader_promoted',
  'fleet_member_died',
  'fleet_passenger_boarded',
  'fleet_passenger_disembarked',
] as const;
export type FleetPushAction = (typeof FLEET_PUSH_ACTIONS)[number];
