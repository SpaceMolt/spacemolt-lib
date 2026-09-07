import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLEET_PUSH_ACTIONS, OK_PUSH_ACTIONS, OK_PUSH_TYPES, type FleetPush, type OkPush } from '../src/push-frames.ts';

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

// The exported constant lists are what a consumer greps or enumerates. If a
// union member is added without touching them they drift apart silently, and
// the lists are the half that looks authoritative.
test('the exported discriminator lists match the unions', () => {
  // Each entry must be assignable, which only compiles while the union carries
  // a member with that literal discriminator. Extract rather than a keyof
  // index: keyof over a union is the intersection of its members' keys, and
  // these members split across `action` and `type`, so the index would be
  // never and assert nothing.
  type OkAction = Extract<OkPush, { action: string }>['action'];
  type OkType = Extract<OkPush, { type: string }>['type'];
  const okActions: OkAction[] = [...OK_PUSH_ACTIONS];
  const okTypes: OkType[] = [...OK_PUSH_TYPES];
  const fleetActions: FleetPush['action'][] = [...FLEET_PUSH_ACTIONS];
  expect(okTypes.length).toBe(7);
  expect(okActions.length).toBe(12);
  expect(fleetActions.length).toBe(6);
  expect(OK_PUSH_TYPES.length).toBe(7);

  // No value may appear in both keys — a payload carries `action` or `type`,
  // never both, and a consumer narrowing on the wrong one would always miss.
  const overlap = OK_PUSH_ACTIONS.filter((a) => (OK_PUSH_TYPES as readonly string[]).includes(a));
  expect(overlap).toEqual([]);
});

// Narrowing is the entire deliverable. These assignments only compile when the
// discriminated union resolves each variant to its own field set, so the test
// body is really the typecheck; the runtime expectations just keep it honest.
test('an ok push narrows to its variant fields', () => {
  const docked: OkPush = {
    action: 'fleet_dock',
    base: 'Earth Station',
    base_id: 'earth_station_base',
    message: 'Your fleet has docked.',
  };
  if (docked.action !== 'fleet_dock') throw new Error('unreachable');
  // base_id is the canonical id; base is only a display name.
  expect(docked.base_id).toBe('earth_station_base');

  const warped: OkPush = {
    type: 'emergency_warp_stabilizer_activated',
    home_base: 'Earth Station',
    hull: 40,
    max_hull: 200,
    message: 'Emergency Warp Stabilizer activated!',
  };
  if (!('type' in warped) || warped.type !== 'emergency_warp_stabilizer_activated') {
    throw new Error('unreachable');
  }
  expect(warped.hull).toBe(40);

  const jumped: OkPush = { action: 'jump', destination: 'markeb', arrival_tick: 60, is_wormhole: false };
  if (jumped.action !== 'jump') throw new Error('unreachable');
  expect(jumped.is_wormhole).toBe(false);
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
