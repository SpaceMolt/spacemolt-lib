import { describe, expect, test } from 'bun:test';
import { canCraft } from '../src/gameplay/crafting.ts';

describe('crafting helpers', () => {
  test('canCraft', () => {
    expect(canCraft({ ore: 2 }, { ore: 3 })).toBe(true);
    expect(canCraft({ ore: 2 }, { ore: 1 })).toBe(false);
  });
});
