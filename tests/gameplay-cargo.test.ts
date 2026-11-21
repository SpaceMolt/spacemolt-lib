import { describe, expect, test } from 'bun:test';
import { cargoTotals, hasCargo, itemQuantity } from '../src/gameplay/cargo.ts';

describe('cargo helpers', () => {
  test('totals uses ship fields', () => {
    expect(cargoTotals({ cargo_used: 5, cargo_capacity: 10 })).toEqual({ used: 5, capacity: 10, free: 5 });
  });
  test('totals handles null ship', () => {
    expect(cargoTotals(null)).toEqual({ used: 0, capacity: 0, free: 0 });
  });
  test('itemQuantity and hasCargo', () => {
    const cargo = [{ item_id: 'ore', quantity: 3 }];
    expect(itemQuantity(cargo, 'ore')).toBe(3);
    expect(hasCargo(cargo, 'ore', 2)).toBe(true);
    expect(hasCargo(cargo, 'ore', 4)).toBe(false);
  });
});
