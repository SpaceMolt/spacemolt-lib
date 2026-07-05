import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import type { AuthCredentials } from '../src/auth/credentials.ts';
import { ConnectionClosedError, retryAfterMsFromClose } from '../src/errors.ts';
import type { WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0', release_date: '2026-06-20', release_notes: [], tick_rate: 5,
    current_tick: 1, server_time: 1, game_info: '', website: '', help_text: '', terms: '',
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// --- retryAfterMsFromClose ---

test('retryAfterMsFromClose parses the hint from a 4003 close reason', () => {
  const err = new ConnectionClosedError('closed', 4003, 'connection_rate_limited retry_after=30');
  expect(retryAfterMsFromClose(err)).toBe(30_000);
});

test('retryAfterMsFromClose returns undefined for a non-4003 close', () => {
  const err = new ConnectionClosedError('closed', 4001, 'retry_after=30');
  expect(retryAfterMsFromClose(err)).toBeUndefined();
});

test('retryAfterMsFromClose returns undefined for a 4003 close with no parseable hint', () => {
  const err = new ConnectionClosedError('closed', 4003, 'connection_rate_limited');
  expect(retryAfterMsFromClose(err)).toBeUndefined();
});

test('retryAfterMsFromClose returns undefined for a non-ConnectionClosedError', () => {
  expect(retryAfterMsFromClose(new Error('boom'))).toBeUndefined();
});

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

test('reconnects after connection_rate_limited (4003), honoring the retry_after hint over the fallback backoff', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    credentials: creds(),
    // A large fallback so honoring the 1s retry_after hint is unambiguous.
    reconnect: { baseDelayMs: 5000, maxRetries: 3 },
  });
  const cp = account.connect();
  serveAuth(sockets[0]!);
  await cp;
  await account.login({ username: 'Nova', password: 'pw' });

  const reconnected = new Promise<void>((resolve) => account.onReconnected(resolve));
  const start = Date.now();
  sockets[0]!.close(4003, 'retry_after=1'); // 1s hint

  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 5));
  serveAuth(sockets[1]!);
  await reconnected;

  const elapsed = Date.now() - start;
  expect(account.authenticated).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(900); // honored the ~1000ms hint (some timer jitter tolerated)
  expect(elapsed).toBeLessThan(3000); // ...not the 5000ms fallback
}, 6000);

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
        payload: { result: 'pending', structuredContent: { pending: true, command: 'jump', message: 'queued' } },
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

test('mutate() times out and cancels the correlator entry if the pending ack never arrives', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false, queryTimeoutMs: 20 });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;
  // no onClientSend handler — the server never acks the mutation

  await expect(account.mutate('spacemolt', 'craft', { id: 'widget' })).rejects.toThrow(
    /No response to mutation .* within 20ms/,
  );

  // a late ack for the abandoned request must not resolve/crash anything
  const lastRequestId = sockets[0]!.lastRequestId();
  expect(() =>
    sockets[0]!.serverSend({
      type: 'result',
      request_id: lastRequestId,
      payload: { result: 'ok' },
    }),
  ).not.toThrow();
});

test('mutate() times out if acked but no action_result ever arrives, and does not wedge the next mutation', async () => {
  // Regression test for a real incident: craft (and any mutation that queues
  // work and settles within a tick, same as e.g. buy/sell/dock) would hang
  // forever if its action_result went missing after the ack — and because
  // mutations are serialized per account, every later mutation queued up
  // behind it forever too, with no recovery short of a full reconnect.
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    // craft is not a transit action, so it's bounded by fastMutationTimeoutMs,
    // not mutationTimeoutMs — see src/account.ts's TRANSIT_ACTIONS.
    fastMutationTimeoutMs: 20,
  });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'craft') {
      // ack immediately, then never send action_result — simulates the
      // reported "craft jobs hang forever" bug.
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'craft', message: 'queued' } },
      });
    } else if (frame.action === 'undock') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'p', structuredContent: { pending: true } },
      });
      s.serverSend({ type: 'action_result', request_id: frame.request_id, payload: { command: 'undock', tick: 2, result: {} } });
    }
  };

  await expect(account.mutate('spacemolt', 'craft', { id: 'widget' })).rejects.toThrow(
    /No action_result for mutation .* within 20ms of its ack/,
  );

  // the next mutation on this account must not be wedged behind the hung one
  const result = await account.mutate('spacemolt', 'undock');
  expect(result.command).toBe('undock');
});

test('a late action_result arriving after the timeout already fired still updates state, and logs a warning', async () => {
  // Regression for a real incident: the server sometimes genuinely finishes
  // processing a mutation later than fastMutationTimeoutMs/mutationTimeoutMs,
  // not never — the outcome frame does eventually arrive, just after the
  // caller already gave up and the correlator entry was cancelled. This must
  // not throw or corrupt state; the cache still applies the delta (it's
  // unconditional, regardless of whether a caller is still listening), and a
  // warning fires so this is visible instead of silently vanishing into the
  // untended notification path.
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    fastMutationTimeoutMs: 20,
  });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  let requestId: string | undefined;
  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      requestId = frame.request_id;
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'queued' } },
      });
    }
  };

  await expect(account.mutate('spacemolt', 'mine')).rejects.toThrow(/No action_result/);
  expect(requestId).toBeDefined();

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    sockets[0]!.serverSend({
      type: 'action_result',
      request_id: requestId,
      payload: { command: 'mine', tick: 5, result: { cargo: [{ item_id: 'iron_ore', quantity: 10 }] } },
    });
  } finally {
    console.warn = originalWarn;
  }

  expect(warnings.some((args) => String(args[0]).includes('no matching pending mutation'))).toBe(true);
  expect(account.cargo).toEqual([{ item_id: 'iron_ore', quantity: 10 }]);
});

test('jump/travel use the long mutationTimeoutMs even when fastMutationTimeoutMs is tiny', async () => {
  // Regression: only jump/travel (TRANSIT_ACTIONS) can legitimately take many
  // ticks (distance-based transit time) — every other mutation now gets the
  // much shorter fastMutationTimeoutMs. A tiny fastMutationTimeoutMs must not
  // leak into jump's bound.
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    fastMutationTimeoutMs: 5,
    mutationTimeoutMs: 200,
  });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'jump', message: 'queued' } },
      });
      // never send action_result — jump should still wait out mutationTimeoutMs (200ms), not fastMutationTimeoutMs (5ms)
    }
  };

  await expect(account.mutate('spacemolt', 'jump', { id: 'alpha' })).rejects.toThrow(
    /No action_result for mutation .* within 200ms of its ack/,
  );
});

test('a non-transit mutation is bounded by fastMutationTimeoutMs, not the long mutationTimeoutMs', async () => {
  const { factory, sockets } = mockFactory();
  const account = new Account({
    url: 'ws://m',
    webSocketFactory: factory,
    seedState: false,
    fastMutationTimeoutMs: 20,
    mutationTimeoutMs: 100_000,
  });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'mine') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'pending', structuredContent: { pending: true, command: 'mine', message: 'queued' } },
      });
      // never send action_result
    }
  };

  await expect(account.mutate('spacemolt', 'mine')).rejects.toThrow(
    /No action_result for mutation .* within 20ms of its ack/,
  );
});

test('mutate() resolves immediately on a result frame without pending:true — no action_result is ever coming', async () => {
  // Root cause of the real "craft jobs hang forever" report, found via a live
  // trace: craft/recycle's `dry_run: true` mode queues nothing, so the
  // server's only response is a single `result` frame that IS the complete
  // answer — it has no `pending: true` flag, and no `action_result` follows,
  // ever. The correlator previously assumed every mutation's `result` frame
  // was just the ack (more to come); it needs to check the flag instead of
  // waiting forever for an outcome the server was never going to send.
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false, mutationTimeoutMs: 20 });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'craft') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'Quote only — nothing queued.',
          structuredContent: { action: 'craft', dry_run: true, mode: 'craft', recipe: 'widget' },
        },
      });
    }
  };

  const result = await account.mutate('spacemolt', 'craft', { id: 'widget', dry_run: true });
  expect(result.command).toBe('');
  expect(result.delta.details).toEqual({ action: 'craft', dry_run: true, mode: 'craft', recipe: 'widget' });
});

test('mutate() does NOT resolve early on a jump ack whose pending flag is nested under details', async () => {
  // Regression test for a real incident: a live trace showed jump's ack
  // nests its pending marker under `details` (`{details: {pending: true,
  // command, message}, location: {...}, queue: {...}}`), unlike scan/undock
  // which carry it at the top level. The correlator previously only checked
  // the top level, so it misread every real jump ack as a "nothing queued"
  // final answer (like craft's dry_run) and resolved immediately — releasing
  // the account's mutation lane before the jump actually executed. The next
  // queued jump then hit the server while the previous one was still
  // in-flight and got rejected with `action_pending`, collapsing an entire
  // multi-hop navigate-to-system route within milliseconds.
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m', webSocketFactory: factory, seedState: false });
  const cp = account.connect();
  sockets[0]!.serverSend({ type: 'welcome', payload: welcomePayload() });
  await cp;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'jump') {
      // Exact shape captured live from the real game server.
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'Jump pending.',
          structuredContent: {
            details: { command: 'jump', message: 'Jump action pending. Will execute on next tick.', pending: true },
            location: { system_id: 'alpha', docked_at: null },
            queue: { has_pending: true },
          },
        },
      });
    }
  };

  let resolved = false;
  const mutatePromise = account.mutate('spacemolt', 'jump', { id: 'alpha' }).then((r) => {
    resolved = true;
    return r;
  });

  // The ack alone must not resolve the mutation — only a real action_result should.
  await tick();
  await tick();
  expect(resolved).toBe(false);

  const jumpFrame = sockets[0]!.sent.find((f) => f.action === 'jump');
  sockets[0]!.serverSend({
    type: 'action_result',
    request_id: jumpFrame!.request_id,
    payload: { command: 'jump', tick: 5, result: { location: { system_id: 'alpha' } } },
  });

  const result = await mutatePromise;
  expect(resolved).toBe(true);
  expect(result.command).toBe('jump');
  expect(result.tick).toBe(5);
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
