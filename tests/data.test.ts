import { afterEach, expect, test } from 'bun:test';
import {
  CatalogCache,
  type CatalogAchievement,
  type CatalogItem,
  type CatalogShip,
  type CatalogSkill,
  fetchCatalog,
  fetchCatalogConditional,
} from '../src/data/catalog.ts';
import { MapCache, fetchMap, httpBaseFromWs, type MapSystem } from '../src/data/map.ts';
import { catalog, mapSystem } from './fixtures.ts';
import { fetchStations } from '../src/data/stations.ts';
import { fetchMobileBase } from '../src/data/mobile-base.ts';
import { SpacemoltClient } from '../src/client.ts';
import { httpGet } from '../src/data/http.ts';
import { HttpError } from '../src/errors.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) return { ok: false, status: 404, statusText: 'Not Found' } as Response;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => routes[key],
    } as Response;
  }) as typeof fetch;
}

function jsonResponse(body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
  });
}

function notModifiedResponse(): Response {
  return new Response(null, { status: 304, statusText: 'Not Modified' });
}

test('httpBaseFromWs derives the HTTP origin', () => {
  expect(httpBaseFromWs('wss://game.spacemolt.com/ws/v2')).toBe('https://game.spacemolt.com');
  expect(httpBaseFromWs('ws://localhost:8080/ws/v2')).toBe('http://localhost:8080');
});

test('CatalogCache indexes entries by id', () => {
  const cache = new CatalogCache(
    catalog({
      version: '0.452.0',
      ships: [{ id: 'shuttle', name: 'Shuttle' } as CatalogShip, { id: 'frigate', name: 'Frigate' } as CatalogShip],
      items: [{ id: 'iron_ore' } as CatalogItem],
      skills: [{ id: 'mining' } as CatalogSkill],
      achievements: [{ id: 'artisan', name: 'Artisan' } as CatalogAchievement],
      hidden_achievement_count: 9,
    }),
  );
  expect(cache.version).toBe('0.452.0');
  expect(cache.achievement('artisan')?.name).toBe('Artisan');
  expect(cache.hiddenAchievementCount).toBe(9);
  expect(cache.ship('frigate')?.name).toBe('Frigate');
  expect(cache.item('iron_ore')).toBeDefined();
  expect(cache.ship('nope')).toBeUndefined();
  expect(cache.ships.length).toBe(2);
});

test('fetchCatalog normalizes missing sections', async () => {
  stubFetch({ '/api/catalog.json': { version: '1', ships: [{ id: 'shuttle' }] } });
  const catalog = await fetchCatalog('https://game.spacemolt.com');
  expect(catalog.ships.length).toBe(1);
  expect(catalog.items).toEqual([]); // absent section -> empty
});

test('fetchCatalog validates and sanitizes external JSON', async () => {
  stubFetch({
    '/api/catalog.json': {
      version: 42,
      ships: [null, 'bad', { id: 'shuttle' }],
      items: 'not-an-array',
    },
  });
  const catalog = await fetchCatalog('https://game.spacemolt.com');
  // `version` is required in the spec, so a malformed one normalizes to '' rather
  // than dropping the key and making the catalog fail its own type.
  expect(catalog.version).toBe('');
  expect(catalog.ships).toEqual([{ id: 'shuttle' } as CatalogShip]);
  expect(catalog.items).toEqual([]);

  stubFetch({ '/api/catalog.json': [] });
  expect(fetchCatalog('https://game.spacemolt.com')).rejects.toThrow('catalog response must be a JSON object');
});

test('fetchMap validates and sanitizes external JSON', async () => {
  stubFetch({
    '/api/map': {
      systems: [null, { id: 'sol' }, 'bad'],
      empires: { solarian: '#ffd700', invalid: 42 },
    },
  });
  // fetchMap only filters non-objects; a well-formed-looking entry is trusted
  // and passes through as-is, missing fields and all — hence the cast.
  expect(await fetchMap('https://game.spacemolt.com')).toEqual({
    systems: [{ id: 'sol' } as MapSystem],
    empires: { solarian: '#ffd700' },
  });

  stubFetch({ '/api/map': null });
  expect(fetchMap('https://game.spacemolt.com')).rejects.toThrow('map response must be a JSON object');
});

test('MapCache indexes systems by id', () => {
  const cache = new MapCache({
    systems: [mapSystem({ id: 'sol', name: 'Sol' }), mapSystem({ id: 'alpha_centauri', name: 'Alpha Centauri' })],
    empires: { solarian: '#ffd700' },
  });
  expect(cache.system('sol')?.name).toBe('Sol');
  expect(cache.systems.length).toBe(2);
  expect(cache.empires.solarian).toBe('#ffd700');
});

test('fetchStations validates and sanitizes external JSON', async () => {
  stubFetch({
    '/api/stations': {
      stations: [
        null,
        'bad',
        { id: 'nexus_base', name: 'Nexus Station', system_id: 'nexus_prime', services: ['market'] },
      ],
      empires: [{ id: 'voidborn', name: 'Voidborn Collective' }, { id: 42 }, 'bad'],
    },
  });
  const list = await fetchStations('https://game.spacemolt.com');
  expect(list.stations.length).toBe(1);
  expect(list.stations[0]?.id).toBe('nexus_base');
  expect(list.empires).toEqual([{ id: 'voidborn', name: 'Voidborn Collective' }]);

  // The server marshals an empty station list as null.
  stubFetch({ '/api/stations': { stations: null, empires: null } });
  expect(await fetchStations('https://game.spacemolt.com')).toEqual({ stations: [], empires: [] });

  stubFetch({ '/api/stations': [] });
  expect(fetchStations('https://game.spacemolt.com')).rejects.toThrow('stations response must be a JSON object');
});

test('fetchMobileBase validates external JSON', async () => {
  stubFetch({ '/wheres-mobile-base': { system: 'horizon' } });
  expect(await fetchMobileBase('https://game.spacemolt.com')).toEqual({ system: 'horizon' });

  stubFetch({ '/wheres-mobile-base': { system: 42 } });
  expect(fetchMobileBase('https://game.spacemolt.com')).rejects.toThrow('missing a system id');

  stubFetch({ '/wheres-mobile-base': [] });
  expect(fetchMobileBase('https://game.spacemolt.com')).rejects.toThrow('must be a JSON object');
});

test('fetchCatalogConditional sends If-None-Match and handles 304', async () => {
  const seenEtags: Array<string | null> = [];
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    const requestEtag = new Headers(init?.headers).get('if-none-match');
    seenEtags.push(requestEtag);
    // Second call carries If-None-Match -> answer 304.
    if (requestEtag) return notModifiedResponse();
    return jsonResponse({ version: '1', ships: [{ id: 'shuttle' }] }, '"abc"');
  }) as typeof fetch;

  const first = await fetchCatalogConditional('https://game.spacemolt.com');
  expect(first.notModified).toBe(false);
  expect(first.etag).toBe('"abc"');
  expect(first.catalog?.ships.length).toBe(1);

  const second = await fetchCatalogConditional('https://game.spacemolt.com', first.etag);
  expect(second.notModified).toBe(true);
  expect(second.catalog).toBeUndefined();
  expect(second.etag).toBe('"abc"'); // still-current etag echoed back
  expect(seenEtags[1]).toBe('"abc"');
});

test('CatalogCache.revalidate keeps the instance on 304 and replaces it on change', async () => {
  let version = '1';
  let respondNotModified = false;
  globalThis.fetch = (async (_input: string | URL) => {
    if (respondNotModified) return notModifiedResponse();
    const v = version;
    return jsonResponse({ version: v, ships: [{ id: `ship-${v}` }] }, `"${v}"`);
  }) as typeof fetch;

  const cache = await CatalogCache.load('https://game.spacemolt.com');
  expect(cache.etag).toBe('"1"');

  respondNotModified = true;
  const same = await cache.revalidate('https://game.spacemolt.com');
  expect(same).toBe(cache); // 304 -> same instance, no re-index

  respondNotModified = false;
  version = '2';
  const next = await cache.revalidate('https://game.spacemolt.com');
  expect(next).not.toBe(cache);
  expect(next.version).toBe('2');
  expect(next.ship('ship-2')).toBeDefined();
});

test('client.catalog() revalidates a stale cache and picks up a new catalog', async () => {
  let fullDownloads = 0;
  let revalidations = 0;
  let version = '1';
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    const inm = new Headers(init?.headers).get('if-none-match');
    if (inm) {
      revalidations++;
      if (inm === `"${version}"`) return notModifiedResponse();
    }
    fullDownloads++;
    const v = version;
    return jsonResponse({ version: v, ships: [{ id: `ship-${v}` }] }, `"${v}"`);
  }) as typeof fetch;

  // maxAge 0 -> every call after the first revalidates.
  const client = new SpacemoltClient({ url: 'wss://game.spacemolt.com/ws/v2', catalogMaxAgeMs: 0 });
  const c1 = await client.catalog();
  expect(c1.version).toBe('1');
  expect(fullDownloads).toBe(1);

  // Unchanged catalog -> conditional 304, same instance, no re-download.
  const c2 = await client.catalog();
  expect(c2).toBe(c1);
  expect(revalidations).toBe(1);
  expect(fullDownloads).toBe(1);

  // Server ships a new catalog -> revalidation misses, fresh copy loaded.
  version = '2';
  const c3 = await client.catalog();
  expect(c3).not.toBe(c1);
  expect(c3.version).toBe('2');
  expect(c3.ship('ship-2')).toBeDefined();
});

test('client.catalog() and map() fetch once and cache', async () => {
  let catalogHits = 0;
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/api/catalog.json')) {
      catalogHits++;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ version: '1', ships: [{ id: 'shuttle' }] }),
      } as Response;
    }
    if (url.endsWith('/api/map')) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ systems: [{ id: 'sol' }], empires: {} }),
      } as Response;
    }
    return { ok: false, status: 404, statusText: 'Not Found' } as Response;
  }) as typeof fetch;

  const client = new SpacemoltClient({ url: 'wss://game.spacemolt.com/ws/v2' });
  expect(client.httpBaseUrl).toBe('https://game.spacemolt.com');
  const c1 = await client.catalog();
  const c2 = await client.catalog();
  expect(c1).toBe(c2); // cached
  expect(catalogHits).toBe(1);
  expect(c1.ship('shuttle')).toBeDefined();

  const map = await client.map();
  expect(map.system('sol')).toBeDefined();
});

test('httpGet times out and does not retry', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted', 'AbortError')),
      );
    });
  }) as typeof fetch;
  // Plain try/catch, not `expect(...).rejects`: without the abort signal
  // (a removed `AbortSignal.timeout` in httpGet), fetchImpl's returned
  // promise never settles -- and bun's own per-test timeout below does not
  // preempt an in-flight `expect(promise).rejects`, only a directly
  // awaited one, so `.rejects` would hang right along with the bug this
  // test exists to catch instead of failing fast.
  let threw = false;
  try {
    await httpGet('https://game.spacemolt.com/api/map', { fetchImpl, timeoutMs: 5 });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  expect(calls).toBe(1); // a timeout is not retried — only one attempt was ever made
}, 1000); // without the abort signal, fetchImpl never settles and this test would hang for minutes

test('httpGet retries a 429 (honoring Retry-After seconds) then succeeds', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      return new Response(null, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' } });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  const res = await httpGet('https://game.spacemolt.com/x', { fetchImpl });
  expect(calls).toBe(2);
  expect(await res.json()).toEqual({ ok: true });
});

test('httpGet honors a Retry-After HTTP-date', async () => {
  let calls = 0;
  let expectedWaitMs = 0;
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      // A little in the future, not just 10ms -- with an assertion of
      // `>= 0` (the previous version of this test) always passing even with
      // no wait at all, this needs an actual gap to prove the wait was
      // honored, not skipped.
      const retryAt = new Date(Date.now() + 1200).toUTCString();
      // HTTP-date has 1-second resolution, so what httpGet actually parses
      // back out can be up to ~1s short of the 1200ms requested here —
      // compute the same way it does, and assert against that.
      expectedWaitMs = Math.max(0, Date.parse(retryAt) - Date.now());
      return new Response(null, {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'retry-after': retryAt },
      });
    }
    return jsonResponse({ ok: true });
  }) as typeof fetch;
  const start = Date.now();
  const res = await httpGet('https://game.spacemolt.com/x', { fetchImpl });
  expect(calls).toBe(2);
  // Jitter only adds to the wait, never subtracts, so the elapsed time
  // should be at least the parsed Retry-After (small tolerance for
  // measurement overhead).
  expect(Date.now() - start).toBeGreaterThanOrEqual(expectedWaitMs - 20);
  expect(await res.json()).toEqual({ ok: true });
}, 3000);

test('httpGet throws a typed HttpError once retries are exhausted', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
    calls++;
    return new Response(null, { status: 503, statusText: 'Service Unavailable', headers: { 'retry-after': '0' } });
  }) as typeof fetch;
  try {
    await httpGet('https://game.spacemolt.com/x', { fetchImpl });
    throw new Error('expected httpGet to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(503);
    expect(httpErr.url).toBe('https://game.spacemolt.com/x');
    expect(httpErr.attempts).toBe(4); // 1 initial + 3 retries
    expect(httpErr.message).toBe('GET https://game.spacemolt.com/x -> 503 Service Unavailable');
  }
  expect(calls).toBe(4);
});

test('httpGet throws instead of sleeping through a long Retry-After', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(null, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '3600' } });
  }) as unknown as typeof fetch;
  const err = await httpGet('https://game.spacemolt.com/x', { fetchImpl }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).retryAfterMs).toBe(3_600_000);
  expect((err as HttpError).attempts).toBe(1);
  expect(calls).toBe(1);
});

test('httpGet caps the total (cumulative) base retry wait, not just each attempt individually', async () => {
  // Each Retry-After (1s) is well under maxRetryWaitMs (1.5s) on its own, so
  // a per-attempt-only cap would keep retrying (up to MAX_RETRIES=3, 4
  // calls). The cumulative cap must stop once the running total would
  // exceed maxRetryWaitMs: attempt 1's wait (0 + 1000 <= 1500) is allowed,
  // but attempt 2's (1000 + 1000 = 2000 > 1500) is not -- 2 calls, not 4.
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(null, { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '1' } });
  }) as unknown as typeof fetch;
  const err = await httpGet('https://game.spacemolt.com/x', { fetchImpl, maxRetryWaitMs: 1500 }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).attempts).toBe(2);
  expect(calls).toBe(2);
}, 3000);

test('httpGet lets a non-retryable status through as HttpError immediately', async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
    calls++;
    return new Response(null, { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
  await expect(httpGet('https://game.spacemolt.com/x', { fetchImpl })).rejects.toThrow(
    'GET https://game.spacemolt.com/x -> 404 Not Found',
  );
  expect(calls).toBe(1);
});

test('client.catalog() uses an injected fetchImpl, not global fetch', async () => {
  globalThis.fetch = (async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error('global fetch must not be called when fetchImpl is injected');
  }) as typeof fetch;
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) =>
    jsonResponse({ version: '1', ships: [{ id: 'shuttle' }] })) as typeof fetch;
  const client = new SpacemoltClient({ url: 'wss://game.spacemolt.com/ws/v2', fetchImpl });
  const cache = await client.catalog();
  expect(cache.ship('shuttle')).toBeDefined();
});

test('client.stations() and client.mobileBase() use the client-level fetchImpl', async () => {
  globalThis.fetch = (async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    throw new Error('global fetch must not be called when fetchImpl is injected');
  }) as typeof fetch;
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL, _init?: RequestInit) => {
    seen.push(String(url));
    return String(url).endsWith('/wheres-mobile-base')
      ? jsonResponse({ system: 'sol' })
      : jsonResponse({ stations: [], empires: [] });
  }) as typeof fetch;
  const client = new SpacemoltClient({ url: 'wss://game.spacemolt.com/ws/v2', fetchImpl });
  expect((await client.mobileBase()).system).toBe('sol');
  expect((await client.stations()).stations).toEqual([]);
  expect(seen).toEqual(['https://game.spacemolt.com/wheres-mobile-base', 'https://game.spacemolt.com/api/stations']);
});

test('an HttpError still surfaces when a fetchImpl wrapper already read the body', async () => {
  const fetchImpl = (async () => {
    const res = new Response('nope', { status: 404, statusText: 'Not Found' });
    await res.text(); // e.g. a wrapper measuring bytes without clone()
    return res;
  }) as unknown as typeof fetch;
  const err = await httpGet('https://game.spacemolt.com/x', { fetchImpl }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
});

test('client httpTimeoutMs reaches the data fetches', async () => {
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
    })) as typeof fetch;
  const client = new SpacemoltClient({ url: 'wss://game.spacemolt.com/ws/v2', fetchImpl, httpTimeoutMs: 20 });
  const started = Date.now();
  let err: unknown;
  try {
    await client.stations();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DOMException);
  expect(Date.now() - started).toBeLessThan(1000);
}, 2000);
