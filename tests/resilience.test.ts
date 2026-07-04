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

test('authenticate auto-retries a login after a rate_limited error', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false, maxRateLimitRetries: 3 });
  const cp = account.connect();
  const socket = sockets[0]!;
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  let attempts = 0;
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      attempts++;
      if (attempts === 1) {
        s.serverSend({
          type: 'error',
          request_id: frame.request_id,
          payload: { code: 'rate_limited', message: 'Too many requests. Retry in 0 seconds.' },
        });
      } else {
        s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
      }
    }
  };
  await account.authenticate({ kind: 'login', username: 'Nova', password: 'pw' });
  expect(account.authenticated).toBe(true);
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

// --- connect/auth timeout ---
//
// Without a bounded timeout, a connection the server accepts at the WS/TCP
// level but then never completes at the protocol level (no welcome, no
// logged_in, no error, no close) hangs forever — indistinguishable from
// "still connecting" from the outside. These pin the fix: give up after
// connectTimeoutMs instead.

test('connect() times out and closes the socket if no welcome frame ever arrives', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, connectTimeoutMs: 20 });
  const cp = account.connect(); // synchronously creates sockets[0] via the factory
  let closeCode: number | undefined;
  sockets[0]!.addEventListener('close', (e) => {
    closeCode = e.code;
  });

  await expect(cp).rejects.toThrow(/No welcome frame received within 20ms/);
  // the abandoned connection attempt's socket should have been closed, not
  // left dangling
  expect(closeCode).toBeDefined();
});

test('authenticate() times out if no logged_in/error response ever arrives', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, connectTimeoutMs: 20 });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;
  // no onClientSend handler — the server never responds to the login frame

  await expect(account.authenticate({ kind: 'login', username: 'Nova', password: 'pw' })).rejects.toThrow(
    /No auth response received within 20ms/,
  );
});

test('a subsequent connect attempt is not blocked by a timed-out auth (pendingAuth is cleared)', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    connectTimeoutMs: 20,
    queryTimeoutMs: 20,
  });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  await expect(account.authenticate({ kind: 'login', username: 'Nova', password: 'pw' })).rejects.toThrow();

  // a second attempt on the same (still-open) connection must not be
  // rejected with 'auth_in_progress' — the first attempt's pendingAuth
  // must have been cleared on timeout
  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    } else if (frame.action === 'get_status') {
      s.serverSend({ type: 'result', request_id: frame.request_id, payload: { result: 'ok' } });
    }
  };
  await account.authenticate({ kind: 'login', username: 'Nova', password: 'pw' });
  expect(account.authenticated).toBe(true);
});

// --- query timeout ---

test('query() times out and cancels the correlator entry if no response ever arrives', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false, queryTimeoutMs: 20 });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;
  // no onClientSend handler — the server never responds to the query

  await expect(account.query('spacemolt', 'get_status')).rejects.toThrow(
    /No response to spacemolt\/get_status within 20ms/,
  );

  // a late response for the abandoned request must not resolve/crash
  // anything — the correlator entry should already be gone
  const lastRequestId = sockets[0]!.lastRequestId();
  expect(() =>
    sockets[0]!.serverSend({
      type: 'result',
      request_id: lastRequestId,
      payload: { result: 'ok' },
    }),
  ).not.toThrow();
});

test('query() does not bound a mutation — mutate() can legitimately outlast queryTimeoutMs', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false, queryTimeoutMs: 20 });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      // simulate a long transit: ack immediately, resolve well past queryTimeoutMs
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { command: 'jump', message: 'queued' } },
      });
      setTimeout(() => {
        s.serverSend({
          type: 'action_result',
          request_id: frame.request_id,
          payload: { command: 'jump', tick: 10, result: {} },
        });
      }, 40);
    }
  };

  const result = await account.mutate('spacemolt', 'jump', { id: 'alpha' });
  expect(result.command).toBe('jump');
});

test('a close while waiting for welcome rejects immediately instead of waiting out the timeout', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, connectTimeoutMs: 5000 });

  const cp = account.connect();
  await tick();
  const start = Date.now();
  sockets[0]!.close(1006, 'abnormal');
  await expect(cp).rejects.toThrow();
  expect(Date.now() - start).toBeLessThan(100); // nowhere near the 5000ms timeout
});
