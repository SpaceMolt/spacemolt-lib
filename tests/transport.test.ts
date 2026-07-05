import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import { ConnectionClosedError, SpacemoltError } from '../src/errors.ts';
import type { MutationAck, WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0',
    release_date: '2026-06-20',
    release_notes: [],
    tick_rate: 5,
    current_tick: 1,
    server_time: 1750860000,
    game_info: 'test',
    website: 'https://www.spacemolt.com',
    help_text: 'help',
    terms: 'terms',
  };
}

async function connected(): Promise<{ account: Account; socket: MockSocket }> {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://mock/ws/v2', webSocketFactory: factory, seedState: false });
  const connectP = account.connect();
  const socket = sockets[0]!;
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;
  return { account, socket };
}

test('connect resolves with the welcome payload', async () => {
  const { account } = await connected();
  expect(account.welcome?.version).toBe('0.452.0');
  expect(account.welcome?.tick_rate).toBe(5);
});

test('login resolves on logged_in and marks authenticated', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    }
  };
  const state = await account.login({ username: 'Nova', password: 'pw' });
  expect((state.player as { username: string }).username).toBe('Nova');
  expect(account.authenticated).toBe(true);
});

test('register resolves with generated credentials and initial state', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'register') {
      // registered + logged_in arrive as pushes (no request_id) after register
      s.serverSend({ type: 'registered', payload: { password: 'deadbeef', player_id: 'plr_1' } });
      s.serverSend({ type: 'logged_in', payload: { ship: { class_id: 'shuttle' } } });
    }
  };
  const res = await account.register({ username: 'Nova', empire: 'solarian', registration_code: 'code' });
  expect(res.password).toBe('deadbeef');
  expect(res.player_id).toBe('plr_1');
  expect((res.state.ship as { class_id: string }).class_id).toBe('shuttle');
  expect(account.authenticated).toBe(true);
});

test('login rejects with a typed error on auth failure', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({
        type: 'error',
        request_id: frame.request_id,
        payload: { code: 'invalid_credentials', message: 'bad password' },
      });
    }
  };
  await expect(account.login({ username: 'Nova', password: 'wrong' })).rejects.toMatchObject({
    code: 'invalid_credentials',
  });
});

test('query resolves synchronously with result + structuredContent', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'You are in Sol.', structuredContent: { credits: 5000 } },
      });
    }
  };
  const res = await account.query('spacemolt', 'get_status');
  expect(res.result).toBe('You are in Sol.');
  expect(res.structuredContent?.credits).toBe(5000);
});

test('mutation: pending ack fires onAck, action_result resolves with delta', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'jump', message: 'queued' } },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: { command: 'jump', tick: 1523, result: { ship: { fuel: 60 }, queue: { has_pending: false } } },
      });
    }
  };
  let ack: MutationAck | undefined;
  const res = await account.mutate('spacemolt', 'jump', { target_system: 'sol' }, (a) => (ack = a));
  expect(ack?.command).toBe('jump');
  expect(res.tick).toBe(1523);
  expect((res.delta.ship as { fuel: number }).fuel).toBe(60);
  expect(res.delta.queue?.has_pending).toBe(false);
});

test('mutation rejects on action_error with command + tick', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'jump', message: 'queued' } },
      });
      s.serverSend({
        type: 'action_error',
        request_id: frame.request_id,
        payload: { command: 'jump', tick: 1530, code: 'invalid_target', message: 'unreachable' },
      });
    }
  };
  const err = (await account.mutate('spacemolt', 'jump', { target_system: 'nowhere' }).catch((e) => e)) as SpacemoltError;
  expect(err).toBeInstanceOf(SpacemoltError);
  expect(err.code).toBe('invalid_target');
  expect(err.command).toBe('jump');
  expect(err.tick).toBe(1530);
});

test('mutation rejects on a synchronous error frame (no pending ack)', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'error',
        request_id: frame.request_id,
        payload: { code: 'action_pending', message: 'already queued', pending_command: 'jump' },
      });
    }
  };
  const err = (await account.mutate('spacemolt', 'mine').catch((e) => e)) as SpacemoltError;
  expect(err.code).toBe('action_pending');
  expect(err.pendingCommand).toBe('jump');
});

test('send() dispatches by spec classification (jump=mutation, get_status=query)', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { structuredContent: { pending: true, command: 'jump', message: 'q' }, result: 'p' },
      });
      s.serverSend({
        type: 'action_result',
        request_id: frame.request_id,
        payload: { command: 'jump', tick: 7, result: { location: { system_id: 'sol' } } },
      });
    } else if (frame.action === 'get_status') {
      s.serverSend({ type: 'result', request_id: frame.request_id, payload: { result: 'ok' } });
    }
  };
  const mut = await account.send('spacemolt', 'jump', { target_system: 'sol' });
  expect('delta' in mut && mut.delta.location?.system_id).toBe('sol');
  const q = await account.send('spacemolt', 'get_status');
  expect('result' in q && q.result).toBe('ok');
});

test('in-flight requests reject when the socket closes', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = () => {
    /* never reply */
  };
  const pending = account.query('spacemolt', 'get_status');
  socket.close();
  await expect(pending).rejects.toBeInstanceOf(ConnectionClosedError);
});

test('an unparseable frame is dropped without throwing, and logs a warning', async () => {
  const { account, socket } = await connected();
  const seen: string[] = [];
  account.on('chat_message', (msg) => seen.push(String(msg.content)));

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    expect(() => socket.serverSendRaw('not valid json{{{')).not.toThrow();
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings.some((args) => String(args[0]).includes('dropped unparseable frame'))).toBe(true);

  // the connection itself is unaffected — subsequent well-formed frames still route
  socket.serverSend({ type: 'chat_message', payload: { content: 'still alive' } });
  expect(seen).toEqual(['still alive']);
});
