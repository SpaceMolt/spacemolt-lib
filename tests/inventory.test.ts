/**
 * Unit tests for the pure inventory selectors in `src/state/inventory.ts`.
 */

import { expect, test } from 'bun:test';
import { heldQuantity, mergeInventory } from '../src/index.ts';

test('mergeInventory sums quantities across cargo and storage lists', () => {
  const cargo = [
    { item_id: 'ore', quantity: 10 },
    { item_id: 'fuel_cell', quantity: 2 },
  ];
  const storage = [{ item_id: 'ore', quantity: 40 }];
  const merged = mergeInventory(cargo, storage);
  expect(heldQuantity(merged, 'ore')).toBe(50);
  expect(heldQuantity(merged, 'fuel_cell')).toBe(2);
  expect(heldQuantity(merged, 'nonexistent')).toBe(0);
});

test('mergeInventory with no lists is empty', () => {
  expect(mergeInventory().size).toBe(0);
});
