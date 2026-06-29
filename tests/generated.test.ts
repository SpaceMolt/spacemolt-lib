import { expect, test } from 'bun:test';
import { ACTIONS } from '../src/generated/actions.gen.ts';
import { TYPED_NOTIFICATION_TYPES } from '../src/generated/notifications.gen.ts';
import { STATE_SECTIONS } from '../src/protocol.ts';

test('action catalog is populated and keyed by tool/action', () => {
  const keys = Object.keys(ACTIONS);
  expect(keys.length).toBeGreaterThan(200);
  for (const key of keys) {
    const def = ACTIONS[key]!;
    expect(key).toBe(`${def.tool}/${def.action}`);
    expect(def.kind === 'query' || def.kind === 'mutation').toBe(true);
  }
});

test('known commands resolve with the expected kind', () => {
  expect(ACTIONS['spacemolt/jump']?.kind).toBe('mutation');
  expect(ACTIONS['spacemolt/mine']?.kind).toBe('mutation');
  expect(ACTIONS['spacemolt/get_status']?.kind).toBe('query');
});

test('auth actions are present', () => {
  expect(ACTIONS['spacemolt_auth/login']).toBeDefined();
  expect(ACTIONS['spacemolt_auth/register']).toBeDefined();
  expect(ACTIONS['spacemolt_auth/login_token']).toBeDefined();
});

test('typed notifications include the documented core pushes', () => {
  const present: readonly string[] = TYPED_NOTIFICATION_TYPES;
  for (const t of ['chat_message', 'mining_yield', 'market_update', 'player_died']) {
    expect(present).toContain(t);
  }
});

test('there are eight delta state sections', () => {
  expect(STATE_SECTIONS.length).toBe(8);
});
