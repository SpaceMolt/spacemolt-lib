import { isRecord, requireRecord } from '../validation.ts';

/**
 * Local copy of the static galaxy map (`GET /api/map`).
 *
 * Returns `{ systems, empires }` where `empires` maps an empire id to a display
 * colour. Static per release; the separate `/api/map/activity` overlay (online
 * counts, battles) changes frequently and is not cached here.
 *
 * These shapes are hand-written rather than taken from the spec's `MapData`,
 * which describes this endpoint incorrectly: the component name `MapSystem`
 * collides with the v2 map *command*'s own `MapSystem` (`system_id`, `visited`,
 * nested `position`), and that one wins, so the published `MapData.systems`
 * documents a shape `/api/map` never returns. Adopting it would silently break
 * the `id`-keyed lookup below. Mirrored from `game.MapSystem` in the
 * gameserver's `internal/game/state.go` and verified against the live endpoint;
 * see gameserver-todo #9. The index signature keeps unknown fields readable
 * until then.
 */

export interface MapSystem {
  id: string;
  name: string;
  /** Galactic coordinates, flat on the entry (not a nested `position`). */
  x: number;
  y: number;
  online: number;
  connections: string[];
  empire?: string;
  empire_color?: string;
  is_home?: boolean;
  is_stronghold?: boolean;
  has_battle?: boolean;
  battle_id?: string;
  [key: string]: unknown;
}

export interface GalaxyMap {
  systems: MapSystem[];
  empires: Record<string, string>;
}

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
