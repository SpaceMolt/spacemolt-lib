import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLEET_PUSH_ACTIONS,
  OK_PUSH_ACTIONS,
  OK_PUSH_TYPES,
  type FleetPush,
  type FleetPushAction,
  type OkActionPush,
  type OkPush,
  type OkPushAction,
  type OkPushType,
  type OkTypePush,
} from '../src/push-frames.ts';

/** Compiles only when T is exactly `true`. */
type Assert<T extends true> = T;

/** Compiles only when the union U is fully covered by the literal set L. */
type Covers<U, L> = [Exclude<U, L>] extends [never] ? true : false;

function specSchemas(): Record<string, unknown> {
  const spec = JSON.parse(readFileSync(join(import.meta.dir, '..', 'openapi.json'), 'utf-8'));
  return spec.components?.schemas ?? {};
}

// This is the whole reason src/push-frames.ts is hand-written: the server
// publishes no schema for these two families, so codegen has nothing to derive
// them from. The day it does publish one, the generated type is authoritative
// and the hand-written union becomes a second, silently-drifting source of
// truth. Fail then, so the file gets deleted rather than left to rot.
test('ok and fleet still publish no schema, so hand-written types are still needed', () => {
  const schemas = specSchemas();
  for (const name of ['Notification_ok', 'Notification_fleet']) {
    expect(
      schemas[name],
      `${name} is now published. Delete src/push-frames.ts, drop its on()/events() overloads and index exports, and let codegen supply the payload type instead.`,
    ).toBeUndefined();
  }
});

// The exported lists are the runtime mirror of the unions, and each half looks
// authoritative on its own. Guard BOTH directions: a list entry with no union
// member fails the assignment, and a union member missing from the list fails
// the Exclude. A one-directional check silently permits the second case, which
// is the one that actually happens — you add a variant and forget the list.
// Every union member is in its list. Type-only, so it fails at `bun run
// typecheck` rather than needing a runtime body — and it catches the direction
// that actually goes wrong: adding a variant and forgetting the list.
test('the exported discriminator lists and the unions cover each other', () => {
  // Assigning `true` only compiles when the Exclude is empty. Inside the test
  // body so the compiler counts them as used.
  const _okActionsComplete: Assert<Covers<OkActionPush['action'], OkPushAction>> = true;
  const _okTypesComplete: Assert<Covers<OkTypePush['type'], OkPushType>> = true;
  const _fleetComplete: Assert<Covers<FleetPush['action'], FleetPushAction>> = true;
  expect([_okActionsComplete, _okTypesComplete, _fleetComplete]).toEqual([true, true, true]);

  // The other direction: every list entry names a real union member. These
  // assignments only compile while the union carries that literal.
  const okActions: OkActionPush['action'][] = [...OK_PUSH_ACTIONS];
  const okTypes: OkTypePush['type'][] = [...OK_PUSH_TYPES];
  const fleetActions: FleetPush['action'][] = [...FLEET_PUSH_ACTIONS];
  expect(okActions.length).toBe(OK_PUSH_ACTIONS.length);
  expect(okTypes.length).toBe(OK_PUSH_TYPES.length);
  expect(fleetActions.length).toBe(FLEET_PUSH_ACTIONS.length);

  // No value may appear under both keys — a payload carries `action` or `type`,
  // never both, so a consumer narrowing on the wrong one would always miss.
  const overlap = OK_PUSH_ACTIONS.filter((a) => (OK_PUSH_TYPES as readonly string[]).includes(a));
  expect(overlap).toEqual([]);
});

// Narrowing is the entire deliverable, and it only bites on a value the
// compiler has not already narrowed by its initializer — so take `OkPush` as a
// parameter, the way a real `on('ok')` handler does.
test('an ok push narrows to its variant fields through a guard', () => {
  const seen: string[] = [];
  function handle(p: OkPush): void {
    if ('action' in p && p.action === 'fleet_dock') {
      // base_id is the canonical id; base is only a display name.
      seen.push(p.base_id);
      return;
    }
    if ('type' in p && p.type === 'emergency_warp_stabilizer_activated') {
      seen.push(String(p.hull));
      return;
    }
    if ('action' in p && p.action === 'attack') {
      // Two shapes share the action; `kind` separates them.
      seen.push(p.kind);
      return;
    }
    // A frame the server added after v0.596.2 lands here. The union is closed,
    // so this default is load-bearing — a `never` assertion would be unsafe.
    seen.push('unhandled');
  }

  handle({ action: 'fleet_dock', base: 'Earth Station', base_id: 'earth_station_base' });
  handle({
    type: 'emergency_warp_stabilizer_activated',
    home_base: 'Earth Station',
    hull: 40,
    max_hull: 200,
  });
  handle({ message: 'You killed a drifter.' });

  expect(seen).toEqual(['earth_station_base', '40', 'unhandled']);
});

test('a fleet push narrows to its variant fields', () => {
  const invite: FleetPush = {
    action: 'fleet_invite',
    fleet_id: 'f1',
    leader_name: 'Nova',
    leader_id: 'p1',
    arena_only: false,
    message: 'You were invited.',
  };
  if (invite.action !== 'fleet_invite') throw new Error('unreachable');
  expect(invite.leader_name).toBe('Nova');
});
