import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS } from '../src/generated/actions.gen.ts';
import { TYPED_NOTIFICATION_TYPES } from '../src/generated/notifications.gen.ts';
import { requireValue } from './require-value.ts';
import { isWelcomeFrame, STATE_SECTIONS } from '../src/protocol.ts';
import { WELCOME_PAYLOAD_FIELDS, WELCOME_PAYLOAD_REQUIRED } from '../src/generated/frames.gen.ts';

test('action catalog is populated and keyed by tool/action', () => {
  const keys = Object.keys(ACTIONS);
  expect(keys.length).toBeGreaterThan(200);
  for (const key of keys) {
    const def = requireValue(ACTIONS[key], `expected action definition for ${key}`);
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
  // JumpCommandResponse is the polymorphic jump union (direct jump |
  // pathfinder variants); the member struct kept the JumpResponse name.
  expect(ACTIONS['spacemolt/jump']?.detailsType).toBe('JumpCommandResponse');
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
  expect(paramType('spacemolt_storage/deposit', 'items')).toBe('{ item_id: string; quantity: number }[]');
  expect(paramType('spacemolt_market/create_sell_order', 'orders')).toBe(
    '{ item_id: string; price_each: number; quantity: number }[]',
  );
  // Optional nested fields stay optional; nested enums are preserved.
  expect(paramType('spacemolt_transfer/trade_offer', 'offer_items')).toBe('{ item_id?: string; quantity?: number }[]');
  expect(paramType('spacemolt_market/create_buy_order', 'orders')).toBe(
    '{ deliver_to?: "cargo" | "storage"; item_id: string; price_each: number; quantity: number }[]',
  );
  // A shapeless object array (no declared properties) stays Record<string, unknown>[].
  expect(paramType('spacemolt/recycle', 'jobs')).toBe('Record<string, unknown>[]');
  // An array of enum values must parenthesize the union: `(...)[]`, not `... | "x"[]`
  // (postfix `[]` binds tighter than `|`, which would change the type's meaning).
  // The members are spec-driven and the server adds notification categories
  // over time, so assert the bracketing rule this guards rather than pinning
  // whichever categories exist today.
  const notificationTypes = requireValue(
    paramType('spacemolt/get_notifications', 'types'),
    'expected a rendered type for get_notifications.types',
  );
  expect(notificationTypes).toMatch(/^\("[a-z_]+"(?: \| "[a-z_]+")+\)\[\]$/);
  expect(notificationTypes).toContain('"chat"');
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

// STATE_SECTIONS is hand-maintained (it drives the cache), but the server is
// the authority: each mutation operation publishes the sections it may touch as
// `x-state-sections`, straight from the StateSections bitmask in the
// gameserver's internal/handlers/delta_wrapper.go. A section the server emits
// but this list omits is silently dropped from every delta — a silent, and
// therefore expensive, way to be wrong. `prize_recoveries` reached the server
// this way before the list caught up.
test('STATE_SECTIONS covers every section the spec says deltas carry', () => {
  const spec = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openapi.json'), 'utf-8'));
  const declared = new Set<string>();
  for (const item of Object.values(spec.paths as Record<string, Record<string, unknown>>)) {
    for (const op of Object.values(item)) {
      const sections = (op as { 'x-state-sections'?: unknown })?.['x-state-sections'];
      if (Array.isArray(sections)) for (const s of sections) declared.add(String(s));
    }
  }
  // Sanity: the spec really does publish the extension we're checking against.
  expect(declared.size).toBeGreaterThan(0);
  const known = new Set<string>(STATE_SECTIONS);
  expect([...declared].filter((s) => !known.has(s)).sort()).toEqual([]);
  // Every section in the cache should also be one the server actually emits.
  expect([...known].filter((s) => !declared.has(s)).sort()).toEqual([]);
});

test('the welcome guard tracks the spec, and is not a hand-written list', () => {
  const spec = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openapi.json'), 'utf-8'));
  const schema = spec.components.schemas.WelcomePayload as {
    properties: Record<string, unknown>;
    required: string[];
  };
  // Sanity: the spec really does publish what we generate from.
  expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
  expect(schema.required.length).toBeGreaterThan(0);

  expect(Object.keys(WELCOME_PAYLOAD_FIELDS).sort()).toEqual(Object.keys(schema.properties).sort());
  expect([...WELCOME_PAYLOAD_REQUIRED].sort()).toEqual([...schema.required].sort());
  // Every required field is one we know how to check at runtime.
  for (const field of WELCOME_PAYLOAD_REQUIRED) expect(WELCOME_PAYLOAD_FIELDS[field]).toBeDefined();
});

test('isWelcomeFrame requires the spec-required fields and tolerates the rest', () => {
  const full: Record<string, unknown> = {};
  for (const [field, kind] of Object.entries(WELCOME_PAYLOAD_FIELDS)) {
    full[field] = kind === 'string' ? 'x' : kind === 'number' ? 1 : kind === 'boolean' ? true : [];
  }
  expect(isWelcomeFrame({ type: 'welcome', payload: full })).toBe(true);
  // An unknown field the server adds must not break an older client.
  expect(isWelcomeFrame({ type: 'welcome', payload: { ...full, brand_new_field: 'x' } })).toBe(true);

  const optional = Object.keys(WELCOME_PAYLOAD_FIELDS).filter((f) => !WELCOME_PAYLOAD_REQUIRED.has(f));
  for (const field of optional) {
    const { [field]: _omitted, ...rest } = full;
    expect(isWelcomeFrame({ type: 'welcome', payload: rest })).toBe(true);
  }
  for (const field of WELCOME_PAYLOAD_REQUIRED) {
    const { [field]: _omitted, ...rest } = full;
    expect(isWelcomeFrame({ type: 'welcome', payload: rest })).toBe(false);
    expect(isWelcomeFrame({ type: 'welcome', payload: { ...full, [field]: Symbol('wrong') } })).toBe(false);
  }
});
