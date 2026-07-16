import { isRecord, requireRecord } from '../validation.ts';

/**
 * Station directory (`GET /api/stations`).
 *
 * A public summary of every station in the galaxy — identity, owning
 * empire/faction, system, offered services, condition, and defensive posture —
 * plus the empire display list the server sends alongside it. Live data (the
 * server caches it for ~10s), so fetch on demand rather than caching like the
 * catalog or map.
 *
 * These shapes mirror the server's station list response; they aren't
 * published in the OpenAPI spec yet (see docs/gameserver-todo.md), so they're
 * hand-typed here and kept tolerant of server-side additions via the index
 * signature.
 */

export interface StationSummary {
  id: string;
  name: string;
  description: string;
  empire?: string;
  empire_name?: string;
  faction_id?: string;
  faction_name?: string;
  faction_tag?: string;
  faction_color?: string;
  system_id: string;
  system_name: string;
  services: string[];
  condition: string;
  condition_text: string;
  satisfaction_pct: number;
  facility_count: number;
  /** Damage per tick the station's armed guns can actually deliver — zero when its batteries are out of shells. */
  weapon_dps: number;
  wrecked: boolean;
  [key: string]: unknown;
}

/** An empire display entry from the station list (`{ id, name }`). */
export interface StationEmpire {
  id: string;
  name: string;
}

export interface StationList {
  stations: StationSummary[];
  empires: StationEmpire[];
}

/** Fetch the public station directory. */
export async function fetchStations(httpBaseUrl: string): Promise<StationList> {
  const url = `${httpBaseUrl.replace(/\/$/, '')}/api/stations`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const data = requireRecord(await res.json(), 'stations response');
  const stations = Array.isArray(data.stations) ? (data.stations.filter(isRecord) as StationSummary[]) : [];
  const empires = Array.isArray(data.empires)
    ? data.empires.filter(
        (empire): empire is StationEmpire =>
          isRecord(empire) && typeof empire.id === 'string' && typeof empire.name === 'string',
      )
    : [];
  return { stations, empires };
}
