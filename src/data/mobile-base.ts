import type { MobileBaseLocation } from '../generated/openapi/types.gen.ts';
import { type FetchOptions, httpGet } from './http.ts';
import { requireRecord } from '../validation.ts';

/**
 * Where the galaxy's single moving capital currently is
 * (`GET /wheres-mobile-base`).
 *
 * The mobile base relocates as the game runs, so this is live data — fetch it
 * when you need it rather than caching it like the catalog or map. The response
 * is the spec's published `MobileBaseLocation` (`{ system }`), a system id that
 * indexes into the galaxy map.
 */

/** Fetch the mobile base's current system id. Pass `fetchImpl` to inject a `fetch` (tests, observability). */
export async function fetchMobileBase(httpBaseUrl: string, opts: FetchOptions = {}): Promise<MobileBaseLocation> {
  const url = `${httpBaseUrl.replace(/\/$/, '')}/wheres-mobile-base`;
  const res = await httpGet(url, {
    headers: { accept: 'application/json' },
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  const data = requireRecord(await res.json(), 'mobile base response');
  if (typeof data.system !== 'string') throw new Error('mobile base response is missing a system id');
  return { system: data.system };
}

export type { MobileBaseLocation };
