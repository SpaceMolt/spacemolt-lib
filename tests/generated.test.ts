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

test('queries carry their response type on responseType, not detailsType', () => {
  // A representative query exposes the typed structuredContent response.
  expect(ACTIONS['spacemolt/find_route']?.responseType).toBe('FindRouteResponse');
  expect(ACTIONS['spacemolt/find_route']?.detailsType).toBeUndefined();
  // Coverage: most queries should be typed (spec publishes their responses).
  const queries = Object.values(ACTIONS).filter((a) => a.kind === 'query');
  const typed = queries.filter((a) => a.responseType);
  expect(typed.length).toBeGreaterThan(queries.length * 0.9);
});

test('mutations carry their delta.details type on detailsType, not responseType', () => {
  // A representative mutation exposes its action-specific details response —
  // the one part of a mutation's delta that isn't the generic state-delta
  // shape shared by every mutation.
  expect(ACTIONS['spacemolt/jump']?.detailsType).toBe('JumpResponse');
  expect(ACTIONS['spacemolt/jump']?.responseType).toBeUndefined();
  expect(ACTIONS['spacemolt/dock']?.detailsType).toBe('DockResponse');
  expect(ACTIONS['spacemolt/buy']?.detailsType).toBe('BuyResponse');
  expect(ACTIONS['spacemolt/mine']?.detailsType).toBe('MineResponse');
  // Coverage: every mutation should be typed — verified against the live spec
  // that all 141 mutations publish a details schema, no exceptions.
  const mutations = Object.values(ACTIONS).filter((a) => a.kind === 'mutation');
  const typed = mutations.filter((a) => a.detailsType);
  expect(typed.length).toBe(mutations.length);
});

test('bulk array-of-object params render their element shape, not string[]', () => {
  const paramType = (key: string, param: string): string | undefined =>
    ACTIONS[key]?.params.find((p) => p.name === param)?.type;

  // Storage/market bulk params declare arrays of {item_id, quantity, ...} objects
  // in the spec; the generator must emit that element shape, never collapse to string[].
  expect(paramType('spacemolt_storage/deposit', 'items')).toBe(
    '{ item_id: string; quantity: number }[]',
  );
  expect(paramType('spacemolt_market/create_sell_order', 'orders')).toBe(
    '{ item_id: string; price_each: number; quantity: number }[]',
  );
  // Optional nested fields stay optional; nested enums are preserved.
  expect(paramType('spacemolt_transfer/trade_offer', 'offer_items')).toBe(
    '{ item_id?: string; quantity?: number }[]',
  );
  expect(paramType('spacemolt_market/create_buy_order', 'orders')).toBe(
    '{ deliver_to?: "cargo" | "storage"; item_id: string; price_each: number; quantity: number }[]',
  );
  // A shapeless object array (no declared properties) stays Record<string, unknown>[].
  expect(paramType('spacemolt/craft', 'jobs')).toBe('Record<string, unknown>[]');
  // An array of enum values must parenthesize the union: `(...)[]`, not `... | "x"[]`
  // (postfix `[]` binds tighter than `|`, which would change the type's meaning).
  expect(paramType('spacemolt/get_notifications', 'types')).toBe(
    '("chat" | "combat" | "trade" | "market" | "crafting" | "system")[]',
  );
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
