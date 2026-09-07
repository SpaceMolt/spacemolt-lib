/**
 * Local cache of the subscribed observation watch (current POI + system).
 *
 * Seeded from the `subscribe_observation` baseline and kept current by merging
 * `observation_update` pushes: `*_changed` arrays upsert entities (keyed by
 * their own id), `*_departed` arrays (id strings) remove them, and the
 * cloaked-contact / signature hints are tracked alongside.
 *
 * The watch is a full `get_nearby` replacement, not a players-only feed: the
 * baseline and every update also carry the pirate, empire-NPC, wildlife and
 * intact-prize presence at the watched POI, each with the same
 * changed/departed delta shape as players.
 */

import type {
  CreatureInfo,
  EmpireNpcInfo,
  NotificationObservationUpdate,
  PirateInfo,
  PrizeInfo,
  SubscribeObservationResponse,
} from '../generated/openapi/types.gen.ts';

export type ObservedPlayer = NonNullable<NotificationObservationUpdate['nearby_changed']>[number];
export type CloakedContact = NonNullable<NotificationObservationUpdate['cloaked_resolved']>[number];

export interface ObservationView {
  poi_id?: string;
  system_id?: string;
  /** Tick of the most recent update (0 from the initial baseline). */
  tick: number;
  /** Uncloaked players at the watched POI, keyed by player_id. */
  nearby: Map<string, ObservedPlayer>;
  /** Uncloaked players system-wide, keyed by player_id. */
  system: Map<string, ObservedPlayer>;
  /** Pirate NPCs at the watched POI, keyed by pirate_id. */
  pirates: Map<string, PirateInfo>;
  /** Empire NPCs at the watched POI, keyed by npc_id. */
  empireNpcs: Map<string, EmpireNpcInfo>;
  /** Wildlife at the watched POI, keyed by creature_id. */
  creatures: Map<string, CreatureInfo>;
  /** Intact captured ships at the watched POI, keyed by prize_id. */
  prizes: Map<string, PrizeInfo>;
  /** Cloaked contacts resolved by an active sensor sweep, keyed by target_id. */
  cloaked: Map<string, CloakedContact>;
  /** A faint cloaked-ship signature is present at the watched POI. */
  unknownSignature: boolean;
  /** Whether an active sensor sweep is running. */
  activeScan: boolean;
}

function indexBy<T>(items: readonly T[] | undefined, key: (item: T) => string | undefined): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items ?? []) {
    const k = key(item);
    if (k) map.set(k, item);
  }
  return map;
}

function merge<T>(
  map: Map<string, T>,
  changed: readonly T[] | undefined,
  departed: readonly string[] | undefined,
  key: (item: T) => string | undefined,
): void {
  for (const item of changed ?? []) {
    const k = key(item);
    if (k) map.set(k, item);
  }
  for (const id of departed ?? []) map.delete(id);
}

export class ObservationCache {
  private view: ObservationView | null = null;

  /** Seed (or replace) the watch from a subscribe_observation baseline. */
  seed(snapshot: SubscribeObservationResponse): ObservationView {
    this.view = {
      poi_id: snapshot.poi_id,
      system_id: snapshot.system_id,
      tick: 0,
      nearby: indexBy(snapshot.nearby, (p) => p.player_id),
      system: indexBy(snapshot.system_agents, (p) => p.player_id),
      pirates: indexBy(snapshot.pirates, (p) => p.pirate_id),
      empireNpcs: indexBy(snapshot.empire_npcs, (n) => n.npc_id),
      creatures: indexBy(snapshot.creatures, (c) => c.creature_id),
      prizes: indexBy(snapshot.prizes, (p) => p.prize_id),
      cloaked: indexBy(snapshot.cloaked_contacts, (c) => c.target_id),
      unknownSignature: snapshot.unknown_signature ?? false,
      activeScan: snapshot.active_scan ?? false,
    };
    return this.view;
  }

  /** Merge an observation_update push into the watch. */
  applyUpdate(update: NotificationObservationUpdate): void {
    if (!this.view) {
      this.view = {
        poi_id: update.poi_id,
        system_id: update.system_id,
        tick: update.tick,
        nearby: new Map(),
        system: new Map(),
        pirates: new Map(),
        empireNpcs: new Map(),
        creatures: new Map(),
        prizes: new Map(),
        cloaked: new Map(),
        unknownSignature: false,
        activeScan: false,
      };
    }
    const v = this.view;
    v.tick = update.tick;
    merge(v.nearby, update.nearby_changed, update.nearby_departed, (p) => p.player_id);
    merge(v.system, update.system_changed, update.system_departed, (p) => p.player_id);
    merge(v.pirates, update.pirates_changed, update.pirates_departed, (p) => p.pirate_id);
    merge(v.empireNpcs, update.empire_npcs_changed, update.empire_npcs_departed, (n) => n.npc_id);
    merge(v.creatures, update.creatures_changed, update.creatures_departed, (c) => c.creature_id);
    merge(v.prizes, update.prizes_changed, update.prizes_departed, (p) => p.prize_id);
    merge(v.cloaked, update.cloaked_resolved, update.cloaked_lost, (c) => c.target_id);
    if (update.unknown_signature !== undefined) v.unknownSignature = update.unknown_signature;
    if (update.active_scan !== undefined) v.activeScan = update.active_scan;
  }

  /** The current watch view, if subscribed. */
  current(): ObservationView | null {
    return this.view;
  }

  /** Clear the watch (e.g. on unsubscribe). */
  clear(): void {
    this.view = null;
  }
}
