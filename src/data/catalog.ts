import type {
  CatalogAchievement,
  CatalogDump,
  FacilityDefinition,
  Item,
  Module,
  Recipe,
  ShipClass,
  SkillDefinition,
} from '../generated/openapi/types.gen.ts';
import { isRecord, requireRecord } from '../validation.ts';

/**
 * Local copy of the bulk game catalog (`GET /api/catalog.json`).
 *
 * Reference data — ships, items, recipes, skills, facilities — that changes
 * only on a server release. Entry shapes come from the spec's published
 * `CatalogDump` component types (`ShipClass`, `Item`/`Module`, `Recipe`,
 * `SkillDefinition`, `FacilityDefinition`), so they track the server via the
 * spec sync. Entries are structurally validated as JSON objects and then
 * trusted to match the spec — the same trust model as state-cache deltas.
 *
 * The payload is large (multiple MB), so the server ships it `public,
 * max-age=3600` with a content-hash `ETag`. We keep that ETag on the cache and
 * revalidate conditionally (`If-None-Match`): an unchanged catalog comes back as
 * a ~0-byte `304 Not Modified`, so a long-lived client can cheaply pick up a new
 * catalog after a server release instead of holding the copy it fetched at
 * startup forever (see `SpacemoltClient.catalog`).
 */

/** A ship entry — the spec's `ShipClass` (the dump omits live prices). */
export type CatalogShip = ShipClass;
/** An item entry — regular items and modules share the merged `items` list. */
export type CatalogItem = Item | Module;
export type CatalogRecipe = Recipe;
export type CatalogSkill = SkillDefinition;
export type CatalogFacility = FacilityDefinition;
/** An achievement entry — the same shape for player and faction achievements. */
export type { CatalogAchievement };

/**
 * The normalized catalog. Derived from the spec's `CatalogDump` rather than
 * restated field by field, so a section the server adds breaks `typecheck`
 * here instead of being silently dropped by `normalizeCatalog` — which is how
 * the achievements sections went missing until v0.573.1.
 */
export type Catalog = Omit<CatalogDump, 'ships' | 'items' | 'recipes' | 'skills' | 'facilities'> & {
  ships: CatalogShip[];
  items: CatalogItem[];
  recipes: CatalogRecipe[];
  skills: CatalogSkill[];
  facilities: CatalogFacility[];
};

/** Result of a conditional catalog fetch. */
export interface CatalogFetchResult {
  /** True when the server answered `304 Not Modified` — `catalog` is absent. */
  notModified: boolean;
  /** The freshly fetched catalog (absent on a 304). */
  catalog?: Catalog;
  /** The server's `ETag` for the returned (or still-current) catalog, if any. */
  etag?: string;
}

function catalogEntries<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter(isRecord) as T[]) : [];
}

function normalizeCatalog(value: unknown): Catalog {
  const data = requireRecord(value, 'catalog response');
  return {
    version: typeof data.version === 'string' ? data.version : '',
    ships: catalogEntries<CatalogShip>(data.ships),
    items: catalogEntries<CatalogItem>(data.items),
    recipes: catalogEntries<CatalogRecipe>(data.recipes),
    skills: catalogEntries<CatalogSkill>(data.skills),
    facilities: catalogEntries<CatalogFacility>(data.facilities),
    achievements: catalogEntries<CatalogAchievement>(data.achievements),
    faction_achievements: catalogEntries<CatalogAchievement>(data.faction_achievements),
    hidden_achievement_count: typeof data.hidden_achievement_count === 'number' ? data.hidden_achievement_count : 0,
    hidden_faction_achievement_count:
      typeof data.hidden_faction_achievement_count === 'number' ? data.hidden_faction_achievement_count : 0,
  };
}

/**
 * Fetch the catalog, optionally conditional on a previously seen `ETag`. When
 * `etag` is passed and the server confirms the catalog is unchanged, this
 * returns `{ notModified: true }` after a ~0-byte `304` — no multi-MB download
 * or re-parse. Otherwise it returns the fresh catalog and its new `ETag`.
 */
export async function fetchCatalogConditional(httpBaseUrl: string, etag?: string): Promise<CatalogFetchResult> {
  const url = `${httpBaseUrl.replace(/\/$/, '')}/api/catalog.json`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(url, { headers });
  if (res.status === 304) return { notModified: true, etag };
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  const data: unknown = await res.json();
  return {
    notModified: false,
    catalog: normalizeCatalog(data),
    etag: res.headers?.get?.('etag') ?? undefined,
  };
}

/** Unconditionally fetch and normalize the catalog. */
export async function fetchCatalog(httpBaseUrl: string): Promise<Catalog> {
  const { catalog } = await fetchCatalogConditional(httpBaseUrl);
  if (!catalog) throw new Error('unconditional catalog fetch returned no catalog');
  return catalog;
}

export class CatalogCache {
  private readonly shipsById: Map<string, CatalogShip>;
  private readonly itemsById: Map<string, CatalogItem>;
  private readonly recipesById: Map<string, CatalogRecipe>;
  private readonly skillsById: Map<string, CatalogSkill>;
  private readonly facilitiesById: Map<string, CatalogFacility>;
  private readonly achievementsById: Map<string, CatalogAchievement>;

  constructor(
    readonly catalog: Catalog,
    /** The server `ETag` this catalog was fetched with, for conditional reloads. */
    readonly etag?: string,
  ) {
    this.shipsById = index(catalog.ships);
    this.itemsById = index(catalog.items);
    this.recipesById = index(catalog.recipes);
    this.skillsById = index(catalog.skills);
    this.facilitiesById = index(catalog.facilities);
    this.achievementsById = index([...catalog.achievements, ...catalog.faction_achievements]);
  }

  /** Fetch the catalog and wrap it in a cache. */
  static async load(httpBaseUrl: string): Promise<CatalogCache> {
    const { catalog, etag } = await fetchCatalogConditional(httpBaseUrl);
    if (!catalog) throw new Error('unconditional catalog fetch returned no catalog');
    return new CatalogCache(catalog, etag);
  }

  /**
   * Conditionally refresh via `If-None-Match`. Returns `this` unchanged when the
   * server confirms the catalog is still current (a cheap `304`), or a new
   * `CatalogCache` when the catalog has changed.
   */
  async revalidate(httpBaseUrl: string): Promise<CatalogCache> {
    const result = await fetchCatalogConditional(httpBaseUrl, this.etag);
    if (result.notModified) return this;
    if (!result.catalog) throw new Error('modified catalog response returned no catalog');
    return new CatalogCache(result.catalog, result.etag);
  }

  /** Server release this catalog was built for; `''` if the response omitted it. */
  get version(): string {
    return this.catalog.version;
  }

  ship(id: string): CatalogShip | undefined {
    return this.shipsById.get(id);
  }
  item(id: string): CatalogItem | undefined {
    return this.itemsById.get(id);
  }
  recipe(id: string): CatalogRecipe | undefined {
    return this.recipesById.get(id);
  }
  skill(id: string): CatalogSkill | undefined {
    return this.skillsById.get(id);
  }
  facility(id: string): CatalogFacility | undefined {
    return this.facilitiesById.get(id);
  }
  /** Looks up player and faction achievements alike — the ids share one space. */
  achievement(id: string): CatalogAchievement | undefined {
    return this.achievementsById.get(id);
  }

  get ships(): readonly CatalogShip[] {
    return this.catalog.ships;
  }
  get items(): readonly CatalogItem[] {
    return this.catalog.items;
  }
  get recipes(): readonly CatalogRecipe[] {
    return this.catalog.recipes;
  }
  get skills(): readonly CatalogSkill[] {
    return this.catalog.skills;
  }
  get facilities(): readonly CatalogFacility[] {
    return this.catalog.facilities;
  }
  get achievements(): readonly CatalogAchievement[] {
    return this.catalog.achievements;
  }
  get factionAchievements(): readonly CatalogAchievement[] {
    return this.catalog.faction_achievements;
  }
  /**
   * Achievements the server withholds from the catalog until earned, reported
   * as a count so a client can show "9 hidden" rather than imply the list is
   * complete.
   */
  get hiddenAchievementCount(): number {
    return this.catalog.hidden_achievement_count;
  }
  get hiddenFactionAchievementCount(): number {
    return this.catalog.hidden_faction_achievement_count;
  }
}

function index<T>(entries: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const entry of entries) {
    const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : undefined;
    if (id) map.set(id, entry);
  }
  return map;
}
