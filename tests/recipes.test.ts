import { describe, expect, test } from 'bun:test';
import type { CatalogItem, CatalogRecipe } from '../src/data/catalog.ts';
import { collectRawTotals, RecipeGraph, traceTree } from '../src/data/recipes.ts';
import { requireValue } from './require-value.ts';

/** Minimal recipe fixture — only the fields the graph reads plus the required ones. */
function r(
  id: string,
  output: string,
  inputs: Array<[string, number]>,
  extra: Partial<CatalogRecipe> = {},
): CatalogRecipe {
  return {
    id,
    name: id,
    description: '',
    category: 'Components',
    crafting_time: 1,
    outputs: [{ item_id: output, quantity: 1 }],
    inputs: inputs.map(([item_id, quantity]) => ({ item_id, quantity })),
    ...extra,
  };
}

function item(id: string, extra: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id,
    name: id,
    description: '',
    category: 'ore',
    base_value: 1,
    size: 1,
    stackable: true,
    tradeable: true,
    ...extra,
  };
}

describe('ranking', () => {
  test('best recipe = fewest raw leaves', () => {
    const g = new RecipeGraph([
      r('x_two', 'X', [
        ['raw1', 1],
        ['raw2', 1],
      ]),
      r('x_one', 'X', [['raw1', 1]]),
    ]);
    expect(g.recipesFor('X').map((rr) => rr.id)).toEqual(['x_one', 'x_two']);
  });

  test('tie on leaf count breaks toward fewer direct inputs', () => {
    const g = new RecipeGraph([
      r('y_p', 'Y', [
        ['a', 1],
        ['b', 1],
      ]),
      r('y_q', 'Y', [['c', 1]]),
      r('c_make', 'c', [
        ['d', 1],
        ['e', 1],
      ]),
    ]);
    expect(requireValue(g.recipesFor('Y')[0]).id).toBe('y_q');
  });

  test('recipe with empty inputs is skipped when ranking, but still indexed', () => {
    const g = new RecipeGraph([r('z_empty', 'Z', []), r('z_real', 'Z', [['raw1', 1]])]);
    expect(g.recipesFor('Z').length).toBe(2);
    expect(requireValue(g.recipe('z_real')).id).toBe('z_real');
    // 0 leaves < 1 leaf, so the zero-input recipe is the primary.
    expect(requireValue(g.recipesFor('Z')[0]).id).toBe('z_empty');
  });

  test('depth cap treats a too-deep chain as a single leaf when ranking', () => {
    const recipes: CatalogRecipe[] = [r('t_chain', 'T', [['n1', 1]])];
    for (let i = 1; i <= 6; i++) recipes.push(r(`n${i}_make`, `n${i}`, [[`n${i + 1}`, 1]]));
    recipes.push(
      r('n7_make', 'n7', [
        ['raw_a', 1],
        ['raw_b', 1],
        ['raw_c', 1],
      ]),
    );
    recipes.push(
      r('t_alt', 'T', [
        ['x', 1],
        ['y', 1],
      ]),
    );
    const g = new RecipeGraph(recipes);
    expect(requireValue(g.recipesFor('T')[0]).id).toBe('t_chain');
  });

  test('ranking is cycle-safe', () => {
    const g = new RecipeGraph([r('a_make', 'A', [['B', 1]]), r('b_make', 'B', [['A', 1]])]);
    expect(requireValue(g.recipesFor('A')[0]).id).toBe('a_make');
  });
});

describe('traceTree / collectRawTotals', () => {
  const g = new RecipeGraph([r('plate', 'plate', [['ore', 2]]), r('gear', 'gear', [['plate', 3]])]);
  const byOutput = new Map([
    ['plate', requireValue(g.recipe('plate'))],
    ['gear', requireValue(g.recipe('gear'))],
  ]);

  test('quantity compounds multiplicatively down the tree', () => {
    const node = traceTree('gear', 1, byOutput);
    expect(node.recipe_id).toBe('gear');
    const plate = requireValue(node.children[0]);
    expect(plate.quantity).toBe(3);
    const ore = requireValue(plate.children[0]);
    expect(ore.item_id).toBe('ore');
    expect(ore.quantity).toBe(6);
    expect(ore.recipe_id).toBeNull();
    expect(ore.children).toEqual([]);
  });

  test('leaf node (no recipe) has null recipe_id', () => {
    const node = traceTree('ore', 5, byOutput);
    expect(node.recipe_id).toBeNull();
    expect(node.quantity).toBe(5);
  });

  test('cycle guard stops recursion', () => {
    const cyc = new RecipeGraph([r('a_make', 'A', [['B', 1]]), r('b_make', 'B', [['A', 1]])]);
    const res = cyc.trace('A');
    if ('error' in res) throw new Error('unexpected error');
    const b = requireValue(requireValue(res.paths[0]).tree.children[0]);
    expect(b.item_id).toBe('B');
    const aAgain = requireValue(b.children[0]);
    expect(aAgain.item_id).toBe('A');
    expect(aAgain.recipe_id).toBeNull();
  });

  test('aggregates leaves and sorts by descending quantity', () => {
    const wg = new RecipeGraph([
      r('widget', 'widget', [
        ['bolt', 4],
        ['ore', 1],
      ]),
      r('bolt', 'bolt', [['ore', 3]]),
    ]);
    const res = wg.trace('widget');
    if ('error' in res) throw new Error('unexpected error');
    // widget → bolt x4 (→ ore x12) + ore x1 ⇒ ore total 13
    expect(collectRawTotals(requireValue(res.paths[0]).tree)).toEqual([{ item_id: 'ore', quantity: 13 }]);
  });

  test('multiple raw materials sorted descending', () => {
    const mg = new RecipeGraph([
      r('mix', 'mix', [
        ['common', 10],
        ['rare', 2],
      ]),
    ]);
    const res = mg.trace('mix');
    if ('error' in res) throw new Error('unexpected error');
    expect(requireValue(res.paths[0]).raw_totals).toEqual([
      { item_id: 'common', quantity: 10 },
      { item_id: 'rare', quantity: 2 },
    ]);
  });
});

describe('trace — query resolution', () => {
  const g = new RecipeGraph([
    r('iron_plate', 'iron_plate', [['ore_iron', 2]]),
    r('copper_wire', 'copper_wire', [['ore_copper', 1]]),
  ]);

  test('exact item match → quantity 1', () => {
    const res = g.trace('iron_plate');
    if ('error' in res) throw new Error('unexpected error');
    expect(res.target).toEqual({ item_id: 'iron_plate', quantity: 1 });
    expect(requireValue(res.paths[0]).label).toBe('Primary path');
  });

  test('quantity multiplies through the tree and the raw totals', () => {
    const res = g.trace('iron_plate', 3);
    if ('error' in res) throw new Error('unexpected error');
    expect(res.target).toEqual({ item_id: 'iron_plate', quantity: 3 });
    expect(requireValue(res.paths[0]).raw_totals).toEqual([{ item_id: 'ore_iron', quantity: 6 }]);
  });

  test('recipe-id match → target is outputs[0], scaled by quantity', () => {
    const batch = r('batch_plate', 'iron_plate', [['ore_iron', 8]]);
    batch.outputs = [{ item_id: 'iron_plate', quantity: 4 }];
    const bg = new RecipeGraph([batch]);
    expect(bg.trace('batch_plate')).toMatchObject({ target: { item_id: 'iron_plate', quantity: 4 } });
    expect(bg.trace('batch_plate', 2)).toMatchObject({ target: { item_id: 'iron_plate', quantity: 8 } });
  });

  test('substring match — exactly one', () => {
    const res = g.trace('plate');
    if ('error' in res) throw new Error('unexpected error');
    expect(res.target.item_id).toBe('iron_plate');
  });

  test('substring match — several → ambiguous with sorted suggestions', () => {
    const many = new RecipeGraph([
      r('iron_plate', 'iron_plate', [['ore_iron', 2]]),
      r('steel_plate', 'steel_plate', [['ore_steel', 2]]),
    ]);
    const res = many.trace('plate');
    if (!('error' in res)) throw new Error('expected error');
    expect(res.error).toContain('Ambiguous');
    expect(res.suggestions).toEqual(['iron_plate', 'steel_plate']);
  });

  test('no match → not-found error', () => {
    const res = g.trace('nonexistent_thing');
    if (!('error' in res)) throw new Error('expected error');
    expect(res.error).toContain('No recipe produces');
  });
});

describe('trace — alt path assembly', () => {
  test('alt recipes produce extra paths, capped at 1 + 4', () => {
    const recipes: CatalogRecipe[] = [r('t_best', 'T', [['raw0', 1]])];
    for (let i = 1; i <= 5; i++) {
      const inputs: Array<[string, number]> = [];
      for (let j = 0; j <= i; j++) inputs.push([`raw${i}_${j}`, 1]);
      recipes.push(r(`t_alt${i}`, 'T', inputs));
    }
    const res = new RecipeGraph(recipes).trace('T');
    if ('error' in res) throw new Error('unexpected error');
    expect(res.paths.length).toBe(5);
    expect(requireValue(res.paths[0]).label).toBe('Primary path');
    expect(requireValue(res.paths[1]).label).toMatch(/^Alt: T via t_alt/);
  });

  test('alt path recomputes raw totals with the overridden recipe', () => {
    const res = new RecipeGraph([
      r('gadget_a', 'gadget', [['part_a', 1]]),
      r('gadget_b', 'gadget', [
        ['part_b1', 1],
        ['part_b2', 1],
      ]),
    ]).trace('gadget');
    if ('error' in res) throw new Error('unexpected error');
    expect(res.paths.length).toBe(2);
    expect(requireValue(res.paths[0]).raw_totals).toEqual([{ item_id: 'part_a', quantity: 1 }]);
    expect(
      requireValue(res.paths[1])
        .raw_totals.map((t) => t.item_id)
        .sort(),
    ).toEqual(['part_b1', 'part_b2']);
  });
});

describe('lookups', () => {
  const recipes = [
    r('refine_iron', 'iron', [['ore_iron', 2]], { category: 'Refining' }),
    r('plate', 'plate', [
      ['iron', 3],
      ['ore_iron', 1],
    ]),
  ];
  const g = new RecipeGraph(recipes, [item('ore_iron', { extracted_by: 'mining' }), item('iron')]);

  test('recipe / recipesFor / usesOf / byCategory', () => {
    expect(requireValue(g.recipe('plate')).name).toBe('plate');
    expect(g.recipe('nope')).toBeUndefined();
    expect(g.recipesFor('iron').map((x) => x.id)).toEqual(['refine_iron']);
    expect(g.recipesFor('unknown_item')).toEqual([]);
    expect(g.usesOf('ore_iron').map((x) => x.id)).toEqual(['refine_iron', 'plate']);
    expect(g.byCategory('Refining').map((x) => x.id)).toEqual(['refine_iron']);
  });

  test('source resolves extraction, then craftability', () => {
    expect(g.source('ore_iron')).toBe('mined');
    expect(g.source('iron')).toBe('crafted');
    expect(g.source('plate')).toBe('crafted');
    expect(g.source('mystery')).toBe('unknown');
  });

  test('source maps every extraction kind', () => {
    const eg = new RecipeGraph(
      [],
      [
        item('g', { extracted_by: 'gas' }),
        item('i', { extracted_by: 'ice' }),
        item('rd', { extracted_by: 'rad' }),
        item('weird', { extracted_by: 'something_new' }),
      ],
    );
    expect(eg.source('g')).toBe('gas');
    expect(eg.source('i')).toBe('ice');
    expect(eg.source('rd')).toBe('rad');
    expect(eg.source('weird')).toBe('unknown');
  });
});

describe('isCraftable', () => {
  const g = new RecipeGraph([]);
  test('rejects hidden, facility-gated, passive and package recipes', () => {
    expect(g.isCraftable(r('ok', 'a', []))).toBe(true);
    expect(g.isCraftable(r('h', 'a', [], { hidden: true }))).toBe(false);
    expect(g.isCraftable(r('f', 'a', [], { facility_only: true }))).toBe(false);
    expect(g.isCraftable(r('c', 'a', [], { category: 'Facility Only' }))).toBe(false);
    expect(g.isCraftable(r('p', 'a', [], { category: 'Ship Passive' }))).toBe(false);
    expect(g.isCraftable(r('pkg', 'a', [], { package_operation: 'unpack' }))).toBe(false);
  });
});

describe('coverage', () => {
  const plate = r('plate', 'plate', [
    ['iron', 3],
    ['ore_iron', 1],
  ]);
  const g = new RecipeGraph([plate], [item('ore_iron', { extracted_by: 'mining' })]);

  test('complete when everything is on hand', () => {
    const cov = g.coverage(plate, { iron: 3, ore_iron: 1 });
    expect(cov.covered).toBe(1);
    expect(cov.complete).toBe(true);
    expect(cov.missing).toEqual([]);
    expect(cov.runs).toBe(1);
  });

  test('partial coverage reports the deficit and its source', () => {
    const cov = g.coverage(plate, new Map([['iron', 1]]));
    expect(cov.covered).toBe(0.25); // 1 of 4 required units
    expect(cov.complete).toBe(false);
    expect(cov.missing).toEqual([
      { item_id: 'iron', quantity: 2, source: 'unknown' },
      { item_id: 'ore_iron', quantity: 1, source: 'mined' },
    ]);
  });

  test('surplus does not inflate coverage past 1', () => {
    expect(g.coverage(plate, { iron: 100, ore_iron: 100 }).covered).toBe(1);
  });

  test('runs scale the requirement', () => {
    const cov = g.coverage(plate, { iron: 3, ore_iron: 1 }, 2);
    expect(cov.runs).toBe(2);
    expect(cov.covered).toBe(0.5);
    expect(cov.missing).toEqual([
      { item_id: 'iron', quantity: 3, source: 'unknown' },
      { item_id: 'ore_iron', quantity: 1, source: 'mined' },
    ]);
  });

  test('an input-free recipe is fully covered', () => {
    expect(g.coverage(r('free', 'x', []), {}).covered).toBe(1);
  });
});

describe('craftableWith', () => {
  const recipes = [
    r('full', 'full', [['ore', 1]]),
    r('half', 'half', [
      ['ore', 1],
      ['gas', 1],
    ]),
    r('third', 'third', [
      ['ore', 1],
      ['gas', 1],
      ['ice', 1],
    ]),
    r('none', 'none', [['exotic', 1]]),
    r('facility', 'facility', [['ore', 1]], { facility_only: true }),
    r('refined', 'refined', [['ore', 1]], { category: 'Refining' }),
    r('secret', 'secret', [['ore', 1]], { hidden: true }),
  ];
  const g = new RecipeGraph(recipes);

  test('lists only partly-covered, craftable recipes, best-first', () => {
    const got = g.craftableWith({ ore: 1 });
    expect(got.map((c) => c.recipe.id)).toEqual(['full', 'refined', 'half', 'third']);
    expect(requireValue(got[0]).complete).toBe(true);
    expect(requireValue(got[2]).covered).toBe(0.5);
  });

  test('excludes facility-only and hidden recipes by default', () => {
    const ids = g.craftableWith({ ore: 1 }).map((c) => c.recipe.id);
    expect(ids).not.toContain('facility');
    expect(ids).not.toContain('secret');
  });

  test('includeFacilityOnly adds facility recipes but never hidden ones', () => {
    const ids = g.craftableWith({ ore: 1 }, { includeFacilityOnly: true }).map((c) => c.recipe.id);
    expect(ids).toContain('facility');
    expect(ids).not.toContain('secret');
  });

  test('categories filter', () => {
    expect(g.craftableWith({ ore: 1 }, { categories: ['Refining'] }).map((c) => c.recipe.id)).toEqual(['refined']);
  });

  test('a recipe with nothing on hand is omitted', () => {
    expect(g.craftableWith({ ore: 1 }).map((c) => c.recipe.id)).not.toContain('none');
  });
});
