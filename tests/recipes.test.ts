import { describe, expect, test } from 'bun:test';
import type { CatalogItem, CatalogRecipe } from '../src/data/catalog.ts';
import { RecipeGraph } from '../src/data/recipes.ts';
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

describe('recipesFor', () => {
  test('returns multiple producers in catalog order', () => {
    const g = new RecipeGraph([r('x_two', 'X', [['raw2', 1]]), r('x_one', 'X', [['raw1', 1]])]);
    expect(g.recipesFor('X').map((rr) => rr.id)).toEqual(['x_two', 'x_one']);
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
    expect(g.source('ore_iron')).toBe('mining');
    expect(g.source('iron')).toBe('crafted');
    expect(g.source('plate')).toBe('crafted');
    expect(g.source('mystery')).toBe('unknown');
  });

  test('source passes any extraction kind through verbatim', () => {
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
    // Not mapped through a local union, so a method the server adds survives.
    expect(eg.source('weird')).toBe('something_new');
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
      { item_id: 'ore_iron', quantity: 1, source: 'mining' },
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
      { item_id: 'ore_iron', quantity: 1, source: 'mining' },
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
