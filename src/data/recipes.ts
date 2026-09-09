/**
 * Recipe graph over the catalog: what produces an item, what consumes it, and
 * what you can craft with what you hold.
 *
 * For a full dependency trace (bill of materials, steps, raw totals,
 * alternates) query the server instead — `spacemolt_catalog` with
 * `{ type: 'recipes', id }` returns an `analysis: RecipeAnalysis` computed
 * server-side. Don't re-derive that locally here.
 *
 * Pure and deterministic given the recipe/item lists — no I/O, no Node
 * built-ins. Build it from a `CatalogCache` (`RecipeGraph.from`) or from bare
 * arrays.
 */

import type { CatalogCache, CatalogItem, CatalogRecipe } from './catalog.ts';

/** How much of a recipe's inputs a given inventory covers. */
export interface Coverage {
  recipe: CatalogRecipe;
  runs: number;
  /** 0..1 fraction of the required input quantity that is on hand. */
  covered: number;
  missing: { item_id: string; quantity: number; source: string }[];
  complete: boolean;
}

function toMap(have: ReadonlyMap<string, number> | Record<string, number>): ReadonlyMap<string, number> {
  return have instanceof Map ? have : new Map(Object.entries(have));
}

/**
 * Recipe graph over the catalog: what produces/consumes an item, and what you
 * can craft with what you hold. For a dependency trace (bill of materials,
 * steps, raw totals, alternates), use the server's `analysis` on a catalog
 * recipe detail (`spacemolt_catalog` `{ type: 'recipes', id }`) instead of
 * re-deriving one here.
 */
export class RecipeGraph {
  private readonly byOutput = new Map<string, CatalogRecipe[]>();
  private readonly byId = new Map<string, CatalogRecipe>();
  private readonly byInput = new Map<string, CatalogRecipe[]>();
  private readonly itemsById = new Map<string, CatalogItem>();

  constructor(
    readonly recipes: readonly CatalogRecipe[],
    readonly items: readonly CatalogItem[] = [],
  ) {
    for (const item of items) this.itemsById.set(item.id, item);

    for (const recipe of recipes) {
      this.byId.set(recipe.id, recipe);
      for (const out of recipe.outputs ?? []) push(this.byOutput, out.item_id, recipe);
      for (const inp of recipe.inputs ?? []) push(this.byInput, inp.item_id, recipe);
    }
  }

  static from(catalog: CatalogCache): RecipeGraph {
    return new RecipeGraph(catalog.recipes, catalog.items);
  }

  recipe(id: string): CatalogRecipe | undefined {
    return this.byId.get(id);
  }

  /** Every recipe producing `itemId`, in catalog order. */
  recipesFor(itemId: string): CatalogRecipe[] {
    return [...(this.byOutput.get(itemId) ?? [])];
  }

  /** Every recipe consuming `itemId`. */
  usesOf(itemId: string): CatalogRecipe[] {
    return [...(this.byInput.get(itemId) ?? [])];
  }

  /**
   * How an item enters the economy: the catalog's `extracted_by` verbatim
   * (`'mining'`, `'gas'`, ...) when the server publishes one, else `'crafted'`
   * if some recipe outputs it, else `'unknown'`. Passed through rather than
   * mapped to a local union so a new extraction method the server adds shows
   * up as itself instead of `'unknown'`.
   */
  source(itemId: string): string {
    // `CatalogItem` is `Item | Module`; only `Item` carries `extracted_by`.
    const entry = this.itemsById.get(itemId);
    const extracted = entry && 'extracted_by' in entry ? entry.extracted_by : undefined;
    if (extracted) return extracted;
    return this.byOutput.has(itemId) ? 'crafted' : 'unknown';
  }

  /**
   * True when a player can hand-craft this recipe at the Station Workshop.
   *
   * Mirrors the server's own `handCraftable` rule
   * (`internal/game/facility_jobs_query.go`), which the catalog does not
   * publish — the `'Facility Only'` / `'Ship Passive'` category strings are
   * matched literally because `facility_only` alone is not sufficient there
   * either. Delete this in favour of the server's flag once `Recipe` carries
   * `hand_craftable` (docs/gameserver-todo.md #16).
   */
  isCraftable(recipe: CatalogRecipe): boolean {
    return (
      !recipe.hidden &&
      !recipe.facility_only &&
      recipe.category !== 'Facility Only' &&
      recipe.category !== 'Ship Passive' &&
      !recipe.package_operation
    );
  }

  /** How much of `recipe`'s inputs (for `runs` runs) the given inventory covers. */
  coverage(recipe: CatalogRecipe, have: ReadonlyMap<string, number> | Record<string, number>, runs = 1): Coverage {
    const stock = toMap(have);
    const missing: Coverage['missing'] = [];
    let required = 0;
    let onHand = 0;

    for (const inp of recipe.inputs ?? []) {
      const need = (inp.quantity ?? 1) * runs;
      const held = Math.min(stock.get(inp.item_id) ?? 0, need);
      required += need;
      onHand += held;
      if (held < need) {
        missing.push({ item_id: inp.item_id, quantity: need - held, source: this.source(inp.item_id) });
      }
    }

    return {
      recipe,
      runs,
      covered: required === 0 ? 1 : onHand / required,
      missing,
      complete: missing.length === 0,
    };
  }

  /**
   * Every recipe the inventory covers at least partly, best-first (most
   * covered, then fewest missing inputs). Facility-gated recipes are excluded
   * unless `includeFacilityOnly` is set; hidden and package-operation recipes
   * are always excluded.
   */
  craftableWith(
    have: ReadonlyMap<string, number> | Record<string, number>,
    opts: { categories?: string[]; includeFacilityOnly?: boolean } = {},
  ): Coverage[] {
    const stock = toMap(have);
    const categories = opts.categories ? new Set(opts.categories) : undefined;
    const out: Coverage[] = [];

    for (const recipe of this.recipes) {
      if (categories && !categories.has(recipe.category)) continue;
      const allowed = opts.includeFacilityOnly
        ? !recipe.hidden && !recipe.package_operation && recipe.category !== 'Ship Passive'
        : this.isCraftable(recipe);
      if (!allowed) continue;
      const cov = this.coverage(recipe, stock);
      if (cov.covered > 0) out.push(cov);
    }

    return out.sort((a, b) => b.covered - a.covered || a.missing.length - b.missing.length);
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
