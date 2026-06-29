/**
 * Local cache of the subscribed observation watch (current POI + system).
 *
 * Seeded from the `subscribe_observation` baseline and kept current by merging
 * `observation_update` pushes: `*_changed` arrays upsert players (keyed by
 * `player_id`), `*_departed` arrays (player_id strings) remove them, and the
 * cloaked-contact / signature hints are tracked alongside.
 */

import type {
  NotificationObservationUpdate,
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
        cloaked: new Map(),
        unknownSignature: false,
        activeScan: false,
      };
    }
    const v = this.view;
    v.tick = update.tick;
    for (const p of update.nearby_changed ?? []) if (p.player_id) v.nearby.set(p.player_id, p);
    for (const id of update.nearby_departed ?? []) v.nearby.delete(id);
    for (const p of update.system_changed ?? []) if (p.player_id) v.system.set(p.player_id, p);
    for (const id of update.system_departed ?? []) v.system.delete(id);
    for (const c of update.cloaked_resolved ?? []) if (c.target_id) v.cloaked.set(c.target_id, c);
    for (const id of update.cloaked_lost ?? []) v.cloaked.delete(id);
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
