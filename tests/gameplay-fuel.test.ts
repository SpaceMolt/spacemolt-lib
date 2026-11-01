import { describe, expect, test } from 'bun:test';
import { needsRefuel } from '../src/gameplay/fuel.ts';

describe('fuel helpers', () => {
  test('needsRefuel boundary', () => {
    expect(needsRefuel(25, 100)).toBe(false);
    expect(needsRefuel(24, 100)).toBe(true);
    expect(needsRefuel(1, 0)).toBe(false);
  });
});
