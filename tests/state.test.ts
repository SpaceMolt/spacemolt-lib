import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import { StateCache } from '../src/state/cache.ts';
import type { V2GameState } from '../src/generated/openapi/types.gen.ts';
import type { StateSection, WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, type MockSocket } from './mock-socket.ts';
import { requireValue } from './require-value.ts';

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

const SNAPSHOT: V2GameState = {
  player: { username: 'Nova', credits: 5000 },
  ship: { class_id: 'shuttle', fuel: 100 },
  location: { system_id: 'sol', poi_id: 'earth_station' },
  cargo: [{ item_id: 'iron_ore', quantity: 10 }],
  skills: { mining: { level: 3 } },
  queue: { has_pending: false },
};

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
    ship: { class_id: 'shuttle', fuel: 60 },
    cargo: [{ item_id: 'iron_ore', quantity: 150 }],
    queue: { has_pending: true },
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
        payload: { command: 'mine', tick: 1523, result: { cargo: [{ item_id: 'iron_ore', quantity: 160 }] } },
      });
    }
  };
  const result = await account.mutate('spacemolt', 'mine');
  expect(result.delta).toEqual({ cargo: [{ item_id: 'iron_ore', quantity: 160 }] });
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
