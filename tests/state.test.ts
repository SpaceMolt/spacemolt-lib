import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import { StateCache } from '../src/state/cache.ts';
import type { V2GameState } from '../src/generated/openapi/types.gen.ts';
import type { StateSection, WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, type MockSocket } from './mock-socket.ts';
import { requireValue } from './require-value.ts';
import { cargoItem, gameState, location, nearbyPlayer, player, queue, resource, ship, skill } from './fixtures.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0',
    release_date: '2026-06-20',
    release_notes: [],
    tick_rate: 5,
    current_tick: 1,
    server_time: 1,
    game_info: '',
    website: '',
    help_text: '',
    terms: '',
  };
}

const SNAPSHOT: V2GameState = gameState({
  player: player({ username: 'Nova', credits: 5000 }),
  ship: ship({ class_id: 'shuttle', fuel: 100 }),
  location: location({
    system_id: 'sol',
    system_name: 'Sol',
    poi_id: 'earth_station',
    poi_name: 'Earth Station',
    connections: ['alpha_centauri'],
    security_status: 'core',
    nearby_players: [nearbyPlayer({ player_id: 'old_neighbor', username: 'Old Neighbor' })],
    resources: [resource({ item_id: 'iron_ore', remaining: 100 })],
  }),
  cargo: [cargoItem({ item_id: 'iron_ore', quantity: 10 })],
  skills: { mining: skill({ name: 'Mining', level: 3 }) },
  queue: queue(),
});

// --- StateCache unit tests ---

test('seed populates sections and reports them changed', () => {
  const cache = new StateCache();
  const changed = cache.seed(SNAPSHOT);
  expect(cache.player?.username).toBe('Nova');
  expect(cache.credits).toBe(5000);
  expect(cache.location?.system_id).toBe('sol');
  expect(changed.sort()).toEqual(
    (['cargo', 'location', 'player', 'queue', 'ship', 'skills'] satisfies StateSection[]).sort(),
  );
});

test('applyDelta replaces present sections and leaves absent ones untouched', () => {
  const cache = new StateCache();
  cache.seed(SNAPSHOT);
  const changed = cache.applyDelta({
    ship: ship({ fuel: 60 }),
    cargo: [cargoItem({ quantity: 150 })],
    queue: queue({ has_pending: true }),
  });
  expect(changed.sort()).toEqual((['cargo', 'queue', 'ship'] satisfies StateSection[]).sort());
  expect(cache.ship?.fuel).toBe(60);
  expect(cache.cargo?.[0]?.quantity).toBe(150);
  expect(cache.hasPendingAction).toBe(true);
  // untouched sections survive
  expect(cache.player?.username).toBe('Nova');
  expect(cache.location?.system_id).toBe('sol');
});

// --- Account integration ---

async function seededAccount(): Promise<{ account: Account; socket: MockSocket }> {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m/ws/v2', webSocketFactory: factory }); // seedState defaults true
  const connectP = account.connect();
  const socket = requireValue(sockets[0], 'expected socket to be created synchronously');
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    } else if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'ok', structuredContent: SNAPSHOT },
      });
    }
  };
  await account.login({ username: 'Nova', password: 'pw' });
  return { account, socket };
}

test('login auto-seeds the cache via get_status', async () => {
  const { account, socket } = await seededAccount();
  expect(account.player?.username).toBe('Nova');
  expect(account.credits).toBe(5000);
  expect(account.location?.system_id).toBe('sol');
  // get_status was issued as part of login
  expect(socket.sent.some((f) => f.action === 'get_status')).toBe(true);
});

test('refresh rejects a get_status response without structured content', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m/ws/v2', webSocketFactory: factory, seedState: false });
  const connectP = account.connect();
  const socket = sockets[0];
  if (!socket) throw new Error('expected socket to be created synchronously');
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;
  socket.onClientSend = (frame, server) => {
    server.serverSend({ type: 'result', request_id: frame.request_id, payload: { result: 'missing' } });
  };

  await expect(account.refresh()).rejects.toMatchObject({ code: 'invalid_response' });
});

test('action_result deltas update the cache and fire onStateChange', async () => {
  const { account, socket } = await seededAccount();
  const changes: StateSection[][] = [];
  account.onStateChange((c) => changes.push(c));
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'q' } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: {
          command: 'mine',
          tick: 1523,
          result: { cargo: [{ item_id: 'iron_ore', quantity: 160 }], queue: { has_pending: false } },
        },
      });
    }
  };
  await account.mutate('spacemolt', 'mine');
  expect(account.cargo?.[0]?.quantity).toBe(160);
  expect(account.player?.username).toBe('Nova'); // untouched section preserved
  expect(changes.at(-1)?.sort()).toEqual(['cargo', 'queue'] satisfies StateSection[]);
});

test('fleet follower movement pushes keep the local location cache current', async () => {
  const { account, socket } = await seededAccount();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            ...SNAPSHOT,
            ship: { ...SNAPSHOT.ship, fuel: 90 },
            location: { system_id: 'markeb', system_name: 'Markeb', poi_id: 'markeb_quantum_eddy' },
            skills: { ...SNAPSHOT.skills, navigation: { level: 1, xp: 3 } },
          },
        },
      });
    }
  };

  // Fleet followers do not issue the jump mutation themselves, so the server
  // sends unsolicited fleet_jump and plain jump-arrival frames instead of an
  // action_result delta tied to this account.
  socket.serverSend({
    type: 'ok',
    payload: {
      action: 'fleet_jump',
      destination: 'markeb',
      arrival_tick: 10,
      message: 'Your fleet is jumping.',
    },
  });
  socket.serverSend({
    type: 'ok',
    payload: {
      action: 'jumped',
      system: 'Markeb',
      system_id: 'markeb',
      from_system: 'Sol',
      navigation_xp: 3,
      poi: 'markeb_quantum_eddy',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(account.location?.system_id).toBe('markeb');
  expect(account.location?.poi_id).toBe('markeb_quantum_eddy');
  // The reconcile snapshot omits these entirely, proving seed() replaces the
  // section wholesale rather than merging into the patched one.
  expect(account.location?.docked_at).toBeUndefined();
  expect(account.location?.connections).toBeUndefined();
  expect(account.location?.nearby_players).toBeUndefined();
  expect(account.location?.resources).toBeUndefined();
  expect(account.ship?.fuel).toBe(90);
  expect(account.skills?.navigation?.xp).toBe(3);
});

// A jump crosses systems, so the system-level fields describe the system the
// ship just left. The arrival push carries only system/system_id/from_system
// and XP (apiresponses.JumpResponse) — never connections, empire or security
// status — so they cannot be refreshed from the push and must not be served as
// though they describe the destination. Asserted synchronously, before the
// reconcile lands: that intermediate window is the whole exposure, and the
// post-reconcile assertions below cannot see it.
test('a fleet jump drops system-level location fields it cannot refresh', async () => {
  const { account, socket } = await seededAccount();
  // Dock first so the jump has a docked_at to clear.
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: { ...SNAPSHOT, location: location({ docked_at: 'sol_station' }) },
        },
      });
    }
  };
  socket.serverSend({
    type: 'ok',
    payload: { action: 'fleet_dock', base: 'Sol Station', message: 'Your fleet has docked.' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(account.location?.docked_at).toBe('sol_station');
  expect(account.location?.connections).toEqual(['alpha_centauri']);

  socket.serverSend({
    type: 'ok',
    payload: { action: 'jumped', system: 'Markeb', system_id: 'markeb', from_system: 'Sol', navigation_xp: 3 },
  });

  expect(account.location?.system_id).toBe('markeb');
  // Stale would be worse than absent here: a consumer picking its next jump off
  // location.connections would get Sol's neighbours labelled as Markeb's.
  expect(account.location?.connections).toBeUndefined();
  expect(account.location?.empire).toBeUndefined();
  expect(account.location?.security_status).toBeUndefined();
  // Arriving anywhere means no longer docked; the server reports that as null.
  expect(account.location?.docked_at).toBeNull();
});

// Travel stays inside one system, so the system-level fields remain true and
// are deliberately kept — only the POI-scoped data is invalidated.
test('an intra-system arrival keeps the system-level location fields', async () => {
  const { account, socket } = await seededAccount();
  socket.serverSend({
    type: 'ok',
    payload: { action: 'arrived', poi: 'Sol Asteroid Belt', poi_id: 'sol_belt' },
  });

  expect(account.location?.poi_id).toBe('sol_belt');
  expect(account.location?.system_id).toBe('sol');
  expect(account.location?.connections).toEqual(['alpha_centauri']);
  expect(account.location?.security_status).toBe('core');
  // POI-scoped data describes the POI just left.
  expect(account.location?.resources).toBeUndefined();
  expect(account.location?.nearby_players).toBeUndefined();
});

test('fleet follower travel pushes update transit and arrival location', async () => {
  const { account, socket } = await seededAccount();
  let atDestination = false;
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            ...SNAPSHOT,
            ship: { ...SNAPSHOT.ship, fuel: 98 },
            location: atDestination
              ? {
                  system_id: 'sol',
                  system_name: 'Sol',
                  poi_id: 'sol_belt',
                  poi_name: 'Sol Asteroid Belt',
                  connections: ['alpha_centauri'],
                  security_status: 'core',
                  in_transit: false,
                }
              : { ...SNAPSHOT.location, in_transit: true, transit_type: 'travel' },
          },
        },
      });
    }
  };

  socket.serverSend({
    type: 'ok',
    payload: {
      action: 'fleet_travel',
      destination: 'sol_belt',
      arrival_tick: 8,
      message: 'Your fleet is traveling.',
    },
  });
  expect(account.location?.in_transit).toBe(true);
  expect(account.location?.transit_type).toBe('travel');
  expect(account.location?.transit_dest_poi_id).toBe('sol_belt');

  atDestination = true;
  socket.serverSend({
    type: 'ok',
    payload: {
      action: 'arrived',
      poi: 'Sol Asteroid Belt',
      poi_id: 'sol_belt',
      online_players_count: 0,
      online_players_truncated: false,
      online_players: [],
      offline_collapsed: 0,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(account.location?.system_id).toBe('sol');
  expect(account.location?.poi_id).toBe('sol_belt');
  expect(account.location?.poi_name).toBe('Sol Asteroid Belt');
  expect(account.location?.in_transit).toBe(false);
  expect(account.location?.transit_type).toBeUndefined();
  expect(account.location?.connections).toEqual(['alpha_centauri']);
  expect(account.location?.security_status).toBe('core');
  expect(account.location?.nearby_players).toBeUndefined();
  expect(account.location?.resources).toBeUndefined();
  expect(account.ship?.fuel).toBe(98);
});

test('fleet travel can establish its system when initial state seeding is disabled', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m/ws/v2', webSocketFactory: factory, seedState: false });
  const connectP = account.connect();
  const socket = requireValue(sockets[0], 'expected socket to be created synchronously');
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            ...SNAPSHOT,
            location: { system_id: 'sol', system_name: 'Sol', poi_id: 'sol_belt', poi_name: 'Sol Asteroid Belt' },
          },
        },
      });
    }
  };

  socket.serverSend({
    type: 'ok',
    payload: {
      action: 'arrived',
      poi: 'Sol Asteroid Belt',
      poi_id: 'sol_belt',
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(account.location?.system_id).toBe('sol');
  expect(account.location?.poi_id).toBe('sol_belt');
});

test('malformed fleet movement pushes do not erase a valid location', async () => {
  const { account, socket } = await seededAccount();
  const before = account.location;

  socket.serverSend({ type: 'ok', payload: { action: 'jumped' } });

  expect(account.location).toEqual(before);
  expect(socket.sent.filter((frame) => frame.action === 'get_status')).toHaveLength(1);
});

test('fleet follower dock refreshes the canonical base ID and undock clears it', async () => {
  const { account, socket } = await seededAccount();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            ...SNAPSHOT,
            location: { ...SNAPSHOT.location, docked_at: 'confederacy_central_command' },
          },
        },
      });
    }
  };

  socket.serverSend({
    type: 'ok',
    payload: { action: 'fleet_dock', base: 'Confederacy Central Command', message: 'Your fleet has docked.' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(account.location?.docked_at).toBe('confederacy_central_command');

  socket.serverSend({ type: 'ok', payload: { action: 'fleet_undock', message: 'Your fleet has undocked.' } });
  expect(account.location?.docked_at).toBeNull();
});

test('a delayed fleet reconciliation cannot overwrite a newer undock push', async () => {
  const { account, socket } = await seededAccount();
  let dockRequestId: string | undefined;
  socket.onClientSend = (frame) => {
    if (frame.action === 'get_status') dockRequestId = frame.request_id;
  };

  socket.serverSend({
    type: 'ok',
    payload: { action: 'fleet_dock', base: 'Confederacy Central Command', message: 'Your fleet has docked.' },
  });
  socket.serverSend({ type: 'ok', payload: { action: 'fleet_undock', message: 'Your fleet has undocked.' } });
  socket.serverSend({
    type: 'result',
    request_id: dockRequestId,
    payload: {
      result: 'ok',
      structuredContent: {
        ...SNAPSHOT,
        location: { ...SNAPSHOT.location, docked_at: 'confederacy_central_command' },
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(account.location?.docked_at).toBeNull();
});

test('a throwing onStateChange listener does not block the mutation it was reporting', async () => {
  // Regression: routeFrame used to call stateListener before correlator.handle
  // for action_result frames. A throwing listener (e.g. a consumer's state
  // projection failing) meant correlator.handle never ran, stranding the
  // awaiting mutate() until its full mutationTimeoutMs — on a connection that
  // never actually closed.
  const { account, socket } = await seededAccount();
  account.onStateChange(() => {
    throw new Error('simulated: downstream projection failed');
  });
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'q' } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: { command: 'mine', tick: 1523, result: { cargo: [cargoItem({ quantity: 160 })] } },
      });
    }
  };
  const result = await account.mutate('spacemolt', 'mine');
  expect(result.delta).toEqual({ cargo: [cargoItem({ quantity: 160 })] });
  // the cache update itself must also have gone through before the throw
  expect(account.cargo?.[0]?.quantity).toBe(160);
});

test('seedState:false skips the get_status seed', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m/ws/v2', webSocketFactory: factory, seedState: false });
  const connectP = account.connect();
  const socket = requireValue(sockets[0], 'expected socket to be created synchronously');
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    }
  };
  await account.login({ username: 'Nova', password: 'pw' });
  expect(socket.sent.some((f) => f.action === 'get_status')).toBe(false);
  expect(account.player).toBeUndefined();
});

test('multiple onStateChange listeners all fire; unsubscribe removes only its own', async () => {
  const { account, socket } = await seededAccount();
  const first: StateSection[][] = [];
  const second: StateSection[][] = [];
  const unsubscribeFirst = account.onStateChange((c) => first.push(c));
  account.onStateChange((c) => second.push(c));
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'q' } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: { command: 'mine', tick: 10, result: { cargo: [{ item_id: 'iron_ore', quantity: 11 }] } },
      });
    }
  };

  await account.mutate('spacemolt', 'mine');
  expect(first.length).toBe(1);
  expect(second.length).toBe(1);

  unsubscribeFirst();
  await account.mutate('spacemolt', 'mine');
  expect(first.length).toBe(1);
  expect(second.length).toBe(2);
});

test('a throwing listener does not starve later onStateChange listeners', async () => {
  const { account, socket } = await seededAccount();
  const survivor: StateSection[][] = [];
  account.onStateChange(() => {
    throw new Error('boom');
  });
  account.onStateChange((c) => survivor.push(c));
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'q' } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: { command: 'mine', tick: 11, result: { queue: { has_pending: false } } },
      });
    }
  };

  await account.mutate('spacemolt', 'mine');
  expect(survivor.length).toBe(1);
});

test('currentTick tracks the highest tick observed and never regresses', async () => {
  const { account, socket } = await seededAccount();
  expect(account.currentTick).toBe(1); // welcome.current_tick

  socket.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'q' } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: { command: 'mine', tick: 1523, result: { queue: { has_pending: false } } },
      });
    }
  };
  await account.mutate('spacemolt', 'mine');
  expect(account.currentTick).toBe(1523);

  // A tick-bearing push advances the clock...
  socket.serverSend({ type: 'crafting_update', payload: { tick: 1600, jobs: [] } });
  expect(account.currentTick).toBe(1600);
  // ...but an older tick never regresses it.
  socket.serverSend({ type: 'crafting_update', payload: { tick: 900, jobs: [] } });
  expect(account.currentTick).toBe(1600);
});
