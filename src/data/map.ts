/**
 * Local copy of the static galaxy map (`GET /api/map`).
 *
 * Returns `{ systems, empires }` where `empires` maps an empire id to a display
 * colour. System shapes aren't in the v2 spec, so they're typed loosely with
 * `id`-keyed lookups. Static per release; the separate `/api/map/activity`
 * overlay (online counts, battles) changes frequently and is not cached here.
 */

export interface MapSystem {
  id?: string;
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
  const data = (await res.json()) as Partial<GalaxyMap>;
  return { systems: data.systems ?? [], empires: data.empires ?? {} };
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
