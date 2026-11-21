import { describe, expect, test } from 'bun:test';
import { hullPercent, shouldFlee } from '../src/gameplay/combat.ts';

describe('combat helpers', () => {
  test('hullPercent', () => {
    expect(hullPercent(5, 10)).toBe(0.5);
    expect(hullPercent(0, 10)).toBe(0);
    expect(hullPercent(5, 0)).toBe(0);
  });
  test('shouldFlee boundary', () => {
    expect(shouldFlee(1, 10, 0.2)).toBe(true);
    expect(shouldFlee(2, 10, 0.2)).toBe(false);
  });
});
