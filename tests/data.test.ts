import { afterEach, expect, test } from 'bun:test';
import { CatalogCache, fetchCatalog } from '../src/data/catalog.ts';
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
