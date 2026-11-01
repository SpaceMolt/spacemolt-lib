import { describe, expect, test } from 'bun:test';
import { needsRepair } from '../src/gameplay/repair.ts';

describe('repair helpers', () => {
  test('needsRepair boundary', () => {
    expect(needsRepair(8, 10, 0.9)).toBe(true);
    expect(needsRepair(9, 10, 0.9)).toBe(false);
    expect(needsRepair(5, 0)).toBe(false);
  });
});
