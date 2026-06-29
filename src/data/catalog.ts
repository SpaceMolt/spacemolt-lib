/**
 * Local copy of the bulk game catalog (`GET /api/catalog.json`).
 *
 * Reference data — ships, items, recipes, skills, facilities — that changes
 * only on a server release. Fetched once over HTTP and cached; the entry
 * shapes aren't in the v2 OpenAPI spec, so they're typed loosely with `id`-keyed
 * lookups. Public, ETag-cached, ~1h max-age on the server.
 */

export interface CatalogEntry {
  id?: string;
  [key: string]: unknown;
}

export interface Catalog {
  version?: string;
  ships: CatalogEntry[];
  items: CatalogEntry[];
  recipes: CatalogEntry[];
  skills: CatalogEntry[];
  facilities: CatalogEntry[];
}

const SECTIONS = ['ships', 'items', 'recipes', 'skills', 'facilities'] as const;
type Section = (typeof SECTIONS)[number];

export async function fetchCatalog(httpBaseUrl: string): Promise<Catalog> {
  const url = `${httpBaseUrl.replace(/\/$/, '')}/api/catalog.json`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Partial<Catalog>;
  return {
    version: data.version,
    ships: data.ships ?? [],
    items: data.items ?? [],
    recipes: data.recipes ?? [],
    skills: data.skills ?? [],
    facilities: data.facilities ?? [],
  };
}

export class CatalogCache {
  private readonly indexes: Record<Section, Map<string, CatalogEntry>>;

  constructor(readonly catalog: Catalog) {
    this.indexes = {
      ships: index(catalog.ships),
      items: index(catalog.items),
      recipes: index(catalog.recipes),
      skills: index(catalog.skills),
      facilities: index(catalog.facilities),
    };
  }

  /** Fetch the catalog and wrap it in a cache. */
  static async load(httpBaseUrl: string): Promise<CatalogCache> {
    return new CatalogCache(await fetchCatalog(httpBaseUrl));
  }

  get version(): string | undefined {
    return this.catalog.version;
  }

  ship(id: string): CatalogEntry | undefined {
    return this.indexes.ships.get(id);
  }
  item(id: string): CatalogEntry | undefined {
    return this.indexes.items.get(id);
  }
  recipe(id: string): CatalogEntry | undefined {
    return this.indexes.recipes.get(id);
  }
  skill(id: string): CatalogEntry | undefined {
    return this.indexes.skills.get(id);
  }
  facility(id: string): CatalogEntry | undefined {
    return this.indexes.facilities.get(id);
  }

  get ships(): readonly CatalogEntry[] {
    return this.catalog.ships;
  }
  get items(): readonly CatalogEntry[] {
    return this.catalog.items;
  }
  get recipes(): readonly CatalogEntry[] {
    return this.catalog.recipes;
  }
  get skills(): readonly CatalogEntry[] {
    return this.catalog.skills;
  }
  get facilities(): readonly CatalogEntry[] {
    return this.catalog.facilities;
  }
}

function index(entries: CatalogEntry[]): Map<string, CatalogEntry> {
  const map = new Map<string, CatalogEntry>();
  for (const entry of entries) {
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (id) map.set(id, entry);
  }
  return map;
}
