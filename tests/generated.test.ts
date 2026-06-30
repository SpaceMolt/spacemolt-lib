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

test('queries carry their response type; mutations do not', () => {
  // A representative query exposes the typed structuredContent response.
  expect(ACTIONS['spacemolt/find_route']?.responseType).toBe('FindRouteResponse');
  // Mutations resolve via the delta, not a structuredContent response schema.
  expect(ACTIONS['spacemolt/jump']?.responseType).toBeUndefined();
  // Coverage: most queries should be typed (spec publishes their responses).
  const queries = Object.values(ACTIONS).filter((a) => a.kind === 'query');
  const typed = queries.filter((a) => a.responseType);
  expect(typed.length).toBeGreaterThan(queries.length * 0.9);
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
