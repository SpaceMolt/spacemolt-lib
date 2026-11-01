import { describe, expect, test } from 'bun:test';
import { estimateFuelOk } from '../src/gameplay/navigation.ts';

describe('navigation helpers', () => {
  test('fuel gate', () => {
    expect(estimateFuelOk({ estimated_fuel: 5, fuel_available: 10 })).toBe(true);
    expect(estimateFuelOk({ estimated_fuel: 10, fuel_available: 5 })).toBe(false);
    expect(estimateFuelOk(null)).toBe(true);
  });
});
