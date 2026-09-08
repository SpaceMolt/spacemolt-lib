/**
 * Recipe graph over the catalog: what produces an item, what consumes it, how
 * to make it from raw materials, and what you can craft with what you hold.
 *
 * Pure and deterministic given the recipe/item lists — no I/O, no Node
 * built-ins. Build it from a `CatalogCache` (`RecipeGraph.from`) or from bare
 * arrays.
 */

import type { CatalogCache, CatalogItem, CatalogRecipe } from './catalog.ts';

/** How an item enters the economy. */
export type ItemSource = 'mined' | 'gas' | 'ice' | 'rad' | 'crafted' | 'unknown';

/** A single node in the expanded dependency tree. */
export interface TraceNode {
  item_id: string;
  /** Compounds multiplicatively down the tree. */
  quantity: number;
  depth: number;
  /** null = leaf (raw / non-craftable, or cycle-stopped). */
  recipe_id: string | null;
  children: TraceNode[];
}

/** A flat raw-material total line. */
export interface RawLine {
  item_id: string;
  quantity: number;
}

/** One traced path (primary or an alternative). */
export interface Path {
  label: string;
  tree: TraceNode;
  /** Flat, sorted by descending quantity. */
  raw_totals: RawLine[];
}

/** Successful trace result. */
export interface TraceSuccess {
  query: string;
  target: { item_id: string; quantity: number };
  paths: Path[];
}

/** Failed trace result (ambiguous or not found). */
export interface TraceError {
  query: string;
  error: string;
  suggestions?: string[];
}

export type TraceResult = TraceSuccess | TraceError;

/** How much of a recipe's inputs a given inventory covers. */
export interface Coverage {
  recipe: CatalogRecipe;
  runs: number;
  /** 0..1 fraction of the required input quantity that is on hand. */
  covered: number;
  missing: { item_id: string; quantity: number; source: ItemSource }[];
  complete: boolean;
}

const DEPTH_CAP = 5;
const MAX_ALT_PATHS = 4;

const EXTRACTION_SOURCES: Record<string, ItemSource> = {
  mining: 'mined',
  gas: 'gas',
  ice: 'ice',
  rad: 'rad',
};

/** Aggregate leaf nodes into a flat list sorted by descending quantity. */
export function collectRawTotals(node: TraceNode): RawLine[] {
  const totals = new Map<string, number>();
  const walk = (n: TraceNode): void => {
    if (n.recipe_id === null) {
      totals.set(n.item_id, (totals.get(n.item_id) ?? 0) + n.quantity);
    } else {
      for (const c of n.children) walk(c);
    }
  };
  walk(node);
  return [...totals.entries()]
    .map(([item_id, quantity]) => ({ item_id, quantity }))
    .sort((a, b) => b.quantity - a.quantity);
}

/**
 * Expand `itemId` into a dependency tree using the chosen recipe per output.
 * Quantities compound multiplicatively; cycles stop as leaves.
 */
export function traceTree(
  itemId: string,
  qty: number,
  byOutput: ReadonlyMap<string, CatalogRecipe>,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): TraceNode {
  const recipe = byOutput.get(itemId);
  if (recipe === undefined || seen.has(itemId)) {
    return { item_id: itemId, quantity: qty, depth, recipe_id: null, children: [] };
  }
  const seen2 = new Set(seen);
  seen2.add(itemId);
  return {
    item_id: itemId,
    quantity: qty,
    depth,
    recipe_id: recipe.id,
    children: recipe.inputs.map((inp) => traceTree(inp.item_id, (inp.quantity ?? 1) * qty, byOutput, depth + 1, seen2)),
  };
}

function toMap(have: ReadonlyMap<string, number> | Record<string, number>): ReadonlyMap<string, number> {
  return have instanceof Map ? have : new Map(Object.entries(have));
}

export class RecipeGraph {
  /** Every recipe producing an item, ranked best-first. */
  private readonly allByOutput = new Map<string, CatalogRecipe[]>();
  /** The rank-0 recipe per item — drives tree expansion. */
  private readonly byOutput = new Map<string, CatalogRecipe>();
  /** Ranks 1..n per item. */
  private readonly altRecipes = new Map<string, CatalogRecipe[]>();
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
      for (const out of recipe.outputs ?? []) push(this.allByOutput, out.item_id, recipe);
      for (const inp of recipe.inputs ?? []) push(this.byInput, inp.item_id, recipe);
    }

    for (const [itemId, list] of this.allByOutput) {
      list.sort((a, b) => {
        const la = this.recipeLeafCount(a);
        const lb = this.recipeLeafCount(b);
        return la !== lb ? la - lb : a.inputs.length - b.inputs.length;
      });
      const best = list[0];
      if (best) this.byOutput.set(itemId, best);
      if (list.length > 1) this.altRecipes.set(itemId, list.slice(1));
    }
  }

  static from(catalog: CatalogCache): RecipeGraph {
    return new RecipeGraph(catalog.recipes, catalog.items);
  }

  recipe(id: string): CatalogRecipe | undefined {
    return this.byId.get(id);
  }

  /** Every recipe producing `itemId`, best-first (fewest raw leaves, then fewest direct inputs). */
  recipesFor(itemId: string): CatalogRecipe[] {
    return [...(this.allByOutput.get(itemId) ?? [])];
  }

  /** Every recipe consuming `itemId`. */
  usesOf(itemId: string): CatalogRecipe[] {
    return [...(this.byInput.get(itemId) ?? [])];
  }

  /** Recipes in a `Recipe.category` (Title Case, e.g. 'Refining'). */
  byCategory(category: string): CatalogRecipe[] {
    return this.recipes.filter((r) => r.category === category);
  }

  source(itemId: string): ItemSource {
    // `CatalogItem` is `Item | Module`; only `Item` carries `extracted_by`.
    const entry = this.itemsById.get(itemId);
    const extracted = entry && 'extracted_by' in entry ? entry.extracted_by : undefined;
    const mapped = extracted ? EXTRACTION_SOURCES[extracted] : undefined;
    if (mapped) return mapped;
    return this.allByOutput.has(itemId) ? 'crafted' : 'unknown';
  }

  /** True when a player can run this recipe themselves (not hidden, not facility-gated, not a package op). */
  isCraftable(recipe: CatalogRecipe): boolean {
    return (
      !recipe.hidden &&
      !recipe.facility_only &&
      recipe.category !== 'Facility Only' &&
      recipe.category !== 'Ship Passive' &&
      !recipe.package_operation
    );
  }

  /**
   * Resolve an item id, a recipe id, or a case-insensitive substring to a
   * target and assemble the primary path plus up to 4 alternatives.
   */
  trace(query: string, quantity = 1): TraceResult {
    let targetItem: string | undefined;
    let targetQty = quantity;

    if (this.byOutput.has(query)) {
      targetItem = query;
    } else {
      const out = this.byId.get(query)?.outputs[0];
      if (out) {
        targetItem = out.item_id;
        targetQty = (out.quantity ?? 1) * quantity;
      }
    }

    if (targetItem === undefined) {
      const q = query.toLowerCase();
      const matches = [...this.byOutput.keys()].filter((k) => k.toLowerCase().includes(q)).sort();
      if (matches.length > 1) {
        return { query, error: `Ambiguous query "${query}" — matches multiple items.`, suggestions: matches };
      }
      const only = matches[0];
      if (only === undefined) return { query, error: `No recipe produces "${query}".` };
      targetItem = only;
    }

    const primaryTree = traceTree(targetItem, targetQty, this.byOutput);
    const paths: Path[] = [makePath('Primary path', primaryTree)];

    const itemsWithAlts: string[] = [];
    collectItemsWithAlts(primaryTree, this.altRecipes, new Set(), itemsWithAlts);

    outer: for (const itemId of itemsWithAlts) {
      for (const alt of this.altRecipes.get(itemId) ?? []) {
        if (paths.length >= 1 + MAX_ALT_PATHS) break outer;
        const modified = new Map(this.byOutput);
        modified.set(itemId, alt);
        paths.push(makePath(`Alt: ${itemId} via ${alt.id}`, traceTree(targetItem, targetQty, modified)));
      }
    }

    return { query, target: { item_id: targetItem, quantity: targetQty }, paths };
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

  /**
   * Fewest raw leaves reachable when crafting `itemId`. Cycles, depth overruns
   * and non-craftable items each count as a single raw leaf.
   */
  private rawLeafCount(itemId: string, depth = 0, seen: ReadonlySet<string> = new Set()): number {
    if (seen.has(itemId)) return 1;
    const recipes = this.allByOutput.get(itemId) ?? [];
    if (recipes.length === 0 || depth > DEPTH_CAP) return 1;

    const seen2 = new Set(seen);
    seen2.add(itemId);
    let best = Number.POSITIVE_INFINITY;
    for (const recipe of recipes) {
      if (recipe.inputs.length === 0) continue;
      let total = 0;
      for (const inp of recipe.inputs) total += this.rawLeafCount(inp.item_id, depth + 1, seen2);
      if (total < best) best = total;
    }
    return best === Number.POSITIVE_INFINITY ? 1 : best;
  }

  private recipeLeafCount(recipe: CatalogRecipe): number {
    let total = 0;
    for (const inp of recipe.inputs) total += this.rawLeafCount(inp.item_id);
    return total;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function makePath(label: string, tree: TraceNode): Path {
  return { label, tree, raw_totals: collectRawTotals(tree) };
}

function collectItemsWithAlts(
  node: TraceNode,
  altRecipes: ReadonlyMap<string, CatalogRecipe[]>,
  seen: Set<string>,
  out: string[],
): void {
  if (seen.has(node.item_id)) return;
  seen.add(node.item_id);
  if (altRecipes.has(node.item_id) && !out.includes(node.item_id)) out.push(node.item_id);
  for (const c of node.children) collectItemsWithAlts(c, altRecipes, seen, out);
}
