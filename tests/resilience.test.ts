import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import type { AuthCredentials } from '../src/auth/credentials.ts';
import type { WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0', release_date: '2026-06-20', release_notes: [], tick_rate: 5,
    current_tick: 1, server_time: 1, game_info: '', website: '', help_text: '', terms: '',
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// --- rate-limit retry ---

test('query auto-retries after a rate_limited error', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false, maxRateLimitRetries: 3 });
  const cp = account.connect();
  const socket = sockets[0]!;
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  let attempts = 0;
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'get_status') {
      attempts++;
      if (attempts === 1) {
        s.serverSend({
          type: 'error',
          request_id: frame.request_id,
          payload: { code: 'rate_limited', message: 'Too many requests. Retry in 0 seconds.' },
        });
      } else {
        s.serverSend({ type: 'result', request_id: frame.request_id, payload: { result: 'ok' } });
      }
    }
  };
  const res = await account.query('spacemolt', 'get_status');
  expect(res.result).toBe('ok');
  expect(attempts).toBe(2);
});

// --- mutation serialization ---

test('mutations are serialized: the second sends only after the first resolves', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false });
  const cp = account.connect();
  const socket = sockets[0]!;
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;
  // no auto-reply: drive the outcomes by hand

  const p1 = account.mutate('spacemolt', 'jump', { target_system: 'a' });
  const p2 = account.mutate('spacemolt', 'jump', { target_system: 'b' });
  await tick();

  const jumps = () => socket.sent.filter((f) => f.action === 'jump');
  expect(jumps().length).toBe(1); // only the first is on the wire

  const first = jumps()[0]!;
  socket.serverSend({ type: 'result', request_id: first.request_id, payload: { result: 'p', structuredContent: { pending: true } } });
  socket.serverSend({ type: 'action_result', request_id: first.request_id, payload: { command: 'jump', tick: 1, result: { location: { system_id: 'a' } } } });
  await p1;
  await tick();

  expect(jumps().length).toBe(2); // second released after the first resolved
  const second = jumps()[1]!;
  socket.serverSend({ type: 'action_result', request_id: second.request_id, payload: { command: 'jump', tick: 2, result: { location: { system_id: 'b' } } } });
  // also ack so nothing dangles
  await p2;
  expect(account.location?.system_id).toBe('b');
});

// --- reconnect ---

function creds(): () => AuthCredentials {
  return () => ({ kind: 'login', username: 'Nova', password: 'pw' });
}

function serveAuth(socket: MockSocket): void {
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    }
  };
}

test('reconnects and re-auths after an unexpected close', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    credentials: creds(),
    reconnect: { baseDelayMs: 1, maxRetries: 3 },
  });
  const cp = account.connect();
  serveAuth(sockets[0]!);
  await cp;
  await account.login({ username: 'Nova', password: 'pw' });
  expect(account.authenticated).toBe(true);

  const reconnected = new Promise<void>((resolve) => account.onReconnected(resolve));
  sockets[0]!.close(1006); // abnormal close -> should reconnect

  // a new socket is created by the reconnect loop; serve its auth
  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 2));
  serveAuth(sockets[1]!);
  await reconnected;
  expect(account.authenticated).toBe(true);
  expect(sockets.length).toBe(2);
});

test('does NOT reconnect on session_replaced (4001)', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    credentials: creds(),
    reconnect: { baseDelayMs: 1, maxRetries: 3 },
  });
  const cp = account.connect();
  serveAuth(sockets[0]!);
  await cp;
  await account.login({ username: 'Nova', password: 'pw' });

  const disconnected = new Promise<number | undefined>((resolve) => account.onDisconnected((e) => resolve(e.code)));
  sockets[0]!.close(4001); // session_replaced -> terminal
  const code = await disconnected;
  expect(code).toBe(4001);
  // give any (incorrect) reconnect a chance to create a socket
  await new Promise((r) => setTimeout(r, 20));
  expect(sockets.length).toBe(1);
});
