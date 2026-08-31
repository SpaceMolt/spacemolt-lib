import type { MapData, MapDataSystem } from '../generated/openapi/types.gen.ts';
import { isRecord, requireRecord } from '../validation.ts';

/**
 * Local copy of the static galaxy map (`GET /api/map`).
 *
 * Returns `{ systems, empires }` where `empires` maps an empire id to a display
 * colour. Static per release; the separate `/api/map/activity` overlay (online
 * counts, battles) changes frequently and is not cached here.
 *
 * Both shapes come from the spec. `MapDataSystem` is the entry this endpoint
 * actually returns (`id` with flat `x`/`y`), published under its own name so it
 * no longer collides with the v2 map *command*'s `MapSystem` (`system_id`, a
 * nested `position`) — which used to win the name and make `MapData.systems`
 * document a shape this endpoint never sends.
 */

/** A system entry from `GET /api/map`. */
export type MapSystem = MapDataSystem;

export type GalaxyMap = MapData;

export async function fetchMap(httpBaseUrl: string): Promise<GalaxyMap> {
  const url = `${httpBaseUrl.replace(/\/$/, '')}/api/map`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const data = requireRecord(await res.json(), 'map response');
  const systems = Array.isArray(data.systems)
    ? data.systems.filter((system): system is MapSystem => isRecord(system))
    : [];
  const empires = isRecord(data.empires)
    ? Object.fromEntries(
        Object.entries(data.empires).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {};
  return { systems, empires };
}

export class MapCache {
  private readonly bySystemId: Map<string, MapSystem>;

  constructor(readonly map: GalaxyMap) {
    this.bySystemId = new Map();
    for (const system of map.systems) {
      const id = typeof system.id === 'string' ? system.id : undefined;
      if (id) this.bySystemId.set(id, system);
    }
  }

  /** Fetch the galaxy map and wrap it in a cache. */
  static async load(httpBaseUrl: string): Promise<MapCache> {
    return new MapCache(await fetchMap(httpBaseUrl));
  }

  system(id: string): MapSystem | undefined {
    return this.bySystemId.get(id);
  }
  get systems(): readonly MapSystem[] {
    return this.map.systems;
  }
  /** Empire id -> display colour. */
  get empires(): Record<string, string> {
    return this.map.empires;
  }
}

/** Derive the HTTP origin from a WebSocket URL (wss://host/ws/v2 -> https://host). */
export function httpBaseFromWs(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${protocol}//${u.host}`;
  } catch {
    return wsUrl;
  }
}
