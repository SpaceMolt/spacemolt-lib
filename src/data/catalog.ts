/**
 * Local copy of the bulk game catalog (`GET /api/catalog.json`).
 *
 * Reference data — ships, items, recipes, skills, facilities — that changes
 * only on a server release. The entry shapes aren't in the v2 OpenAPI spec, so
 * they're typed loosely with `id`-keyed lookups.
 *
 * The payload is large (multiple MB), so the server ships it `public,
 * max-age=3600` with a content-hash `ETag`. We keep that ETag on the cache and
 * revalidate conditionally (`If-None-Match`): an unchanged catalog comes back as
 * a ~0-byte `304 Not Modified`, so a long-lived client can cheaply pick up a new
 * catalog after a server release instead of holding the copy it fetched at
 * startup forever (see `SpacemoltClient.catalog`).
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

/** Result of a conditional catalog fetch. */
export interface CatalogFetchResult {
  /** True when the server answered `304 Not Modified` — `catalog` is absent. */
  notModified: boolean;
  /** The freshly fetched catalog (absent on a 304). */
  catalog?: Catalog;
  /** The server's `ETag` for the returned (or still-current) catalog, if any. */
  etag?: string;
}

function normalizeCatalog(data: Partial<Catalog>): Catalog {
  return {
    version: data.version,
    ships: data.ships ?? [],
    items: data.items ?? [],
    recipes: data.recipes ?? [],
    skills: data.skills ?? [],
    facilities: data.facilities ?? [],
  };
}

/**
 * Fetch the catalog, optionally conditional on a previously seen `ETag`. When
 * `etag` is passed and the server confirms the catalog is unchanged, this
 * returns `{ notModified: true }` after a ~0-byte `304` — no multi-MB download
 * or re-parse. Otherwise it returns the fresh catalog and its new `ETag`.
 */
export async function fetchCatalogConditional(
  httpBaseUrl: string,
  etag?: string,
): Promise<CatalogFetchResult> {
  const url = `${httpBaseUrl.replace(/\/$/, '')}/api/catalog.json`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { notModified: true, etag };
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Partial<Catalog>;
  return {
    notModified: false,
    catalog: normalizeCatalog(data),
    etag: res.headers?.get?.('etag') ?? undefined,
  };
}

/** Unconditionally fetch and normalize the catalog. */
export async function fetchCatalog(httpBaseUrl: string): Promise<Catalog> {
  const { catalog } = await fetchCatalogConditional(httpBaseUrl);
  // A non-304 fetch (no If-None-Match) always carries a catalog.
  return catalog as Catalog;
}

export class CatalogCache {
  private readonly indexes: Record<Section, Map<string, CatalogEntry>>;

  constructor(
    readonly catalog: Catalog,
    /** The server `ETag` this catalog was fetched with, for conditional reloads. */
    readonly etag?: string,
  ) {
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
    const { catalog, etag } = await fetchCatalogConditional(httpBaseUrl);
    return new CatalogCache(catalog as Catalog, etag);
  }

  /**
   * Conditionally refresh via `If-None-Match`. Returns `this` unchanged when the
   * server confirms the catalog is still current (a cheap `304`), or a new
   * `CatalogCache` when the catalog has changed.
   */
  async revalidate(httpBaseUrl: string): Promise<CatalogCache> {
    const result = await fetchCatalogConditional(httpBaseUrl, this.etag);
    if (result.notModified) return this;
    return new CatalogCache(result.catalog as Catalog, result.etag);
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
