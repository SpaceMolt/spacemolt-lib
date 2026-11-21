import { describe, expect, test } from 'bun:test';
import { missionComplete } from '../src/gameplay/missions.ts';

describe('missions helpers', () => {
  test('missionComplete', () => {
    expect(missionComplete([{ complete: true }, { complete: true }])).toBe(true);
    expect(missionComplete([{ complete: true }, { complete: false }])).toBe(false);
    expect(missionComplete([])).toBe(false);
  });
});
