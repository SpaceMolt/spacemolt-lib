import { afterEach, expect, test } from 'bun:test';
import { CatalogCache, fetchCatalog, fetchCatalogConditional } from '../src/data/catalog.ts';
import { MapCache, httpBaseFromWs } from '../src/data/map.ts';
import { SpacemoltClient } from '../src/client.ts';

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

test('httpBaseFromWs derives the HTTP origin', () => {
  expect(httpBaseFromWs('wss://game.spacemolt.com/ws/v2')).toBe('https://game.spacemolt.com');
  expect(httpBaseFromWs('ws://localhost:8080/ws/v2')).toBe('http://localhost:8080');
});

test('CatalogCache indexes entries by id', () => {
  const cache = new CatalogCache({
    version: '0.452.0',
    ships: [{ id: 'shuttle', name: 'Shuttle' }, { id: 'frigate', name: 'Frigate' }],
    items: [{ id: 'iron_ore' }],
    recipes: [],
    skills: [{ id: 'mining' }],
    facilities: [],
  });
  expect(cache.version).toBe('0.452.0');
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

test('MapCache indexes systems by id', () => {
  const cache = new MapCache({
    systems: [{ id: 'sol', name: 'Sol' }, { id: 'alpha_centauri' }],
    empires: { solarian: '#ffd700' },
  });
  expect(cache.system('sol')?.name).toBe('Sol');
  expect(cache.systems.length).toBe(2);
  expect(cache.empires.solarian).toBe('#ffd700');
});

test('fetchCatalogConditional sends If-None-Match and handles 304', async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    seen.push(init?.headers as Record<string, string> | undefined);
    // Second call carries If-None-Match -> answer 304.
    if ((init?.headers as Record<string, string> | undefined)?.['if-none-match']) {
      return { ok: false, status: 304, statusText: 'Not Modified' } as Response;
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? '"abc"' : null) },
      json: async () => ({ version: '1', ships: [{ id: 'shuttle' }] }),
    } as unknown as Response;
  }) as typeof fetch;

  const first = await fetchCatalogConditional('https://game.spacemolt.com');
  expect(first.notModified).toBe(false);
  expect(first.etag).toBe('"abc"');
  expect(first.catalog?.ships.length).toBe(1);

  const second = await fetchCatalogConditional('https://game.spacemolt.com', first.etag);
  expect(second.notModified).toBe(true);
  expect(second.catalog).toBeUndefined();
  expect(second.etag).toBe('"abc"'); // still-current etag echoed back
  expect(seen[1]?.['if-none-match']).toBe('"abc"');
});

test('CatalogCache.revalidate keeps the instance on 304 and replaces it on change', async () => {
  let version = '1';
  let respondNotModified = false;
  globalThis.fetch = (async (_input: string | URL) => {
    if (respondNotModified) return { ok: false, status: 304, statusText: 'Not Modified' } as Response;
    const v = version;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? `"${v}"` : null) },
      json: async () => ({ version: v, ships: [{ id: `ship-${v}` }] }),
    } as unknown as Response;
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
    const inm = (init?.headers as Record<string, string> | undefined)?.['if-none-match'];
    if (inm) {
      revalidations++;
      if (inm === `"${version}"`) return { ok: false, status: 304, statusText: 'Not Modified' } as Response;
    }
    fullDownloads++;
    const v = version;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? `"${v}"` : null) },
      json: async () => ({ version: v, ships: [{ id: `ship-${v}` }] }),
    } as unknown as Response;
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
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ version: '1', ships: [{ id: 'shuttle' }] }) } as Response;
    }
    if (url.endsWith('/api/map')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ systems: [{ id: 'sol' }], empires: {} }) } as Response;
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
