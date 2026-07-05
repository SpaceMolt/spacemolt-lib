import { expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '../src/account.ts';
import { SpacemoltClient } from '../src/client.ts';
import { MemoryCredentialStore } from '../src/auth/credentials.ts';
import { FileCredentialStore } from '../src/auth/file-store.ts';
import type { WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0', release_date: '2026-06-20', release_notes: [], tick_rate: 5,
    current_tick: 1, server_time: 1, game_info: '', website: '', help_text: '', terms: '',
  };
}

/** Auto-respond to welcome/login/get_status so an account connects+auths. */
function autoServe(socket: MockSocket, username: string): void {
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username } } });
    } else if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'ok', structuredContent: { player: { id: `plr_${username}`, username } } },
      });
    }
  };
}

// --- credential stores ---

test('MemoryCredentialStore put/get/list/remove', async () => {
  const store = new MemoryCredentialStore();
  await store.put({ id: 'a', credentials: { kind: 'login', username: 'a', password: 'pw' } });
  expect((await store.get('a'))?.credentials.kind).toBe('login');
  expect((await store.list()).length).toBe(1);
  await store.remove('a');
  expect(await store.get('a')).toBeUndefined();
});

test('FileCredentialStore round-trips through disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smolt-'));
  const path = join(dir, 'creds.json');
  const store = new FileCredentialStore(path);
  await store.put({ id: 'Nova', credentials: { kind: 'login', username: 'Nova', password: 'secret' }, playerId: 'plr_1' });
  // a fresh instance reads what the first wrote
  const reopened = new FileCredentialStore(path);
  const got = await reopened.get('Nova');
  expect(got?.playerId).toBe('plr_1');
  const onDisk = JSON.parse(await readFile(path, 'utf-8'));
  expect(onDisk.version).toBe(1);
  expect(onDisk.accounts.Nova.credentials.password).toBe('secret');
});

// --- multi-account client ---

test('connect authenticates a stored account and captures player id', async () => {
  const { factory, sockets } = mockFactory();
  const store = new MemoryCredentialStore();
  const client = new SpacemoltClient({ webSocketFactory: factory, store });
  await client.addLogin('Nova', 'pw');

  const connectP = client.connect('Nova');
  // the account's socket is created synchronously inside connect()
  await Promise.resolve();
  autoServe(sockets[0]!, 'Nova');
  const account = await connectP;

  expect(account.authenticated).toBe(true);
  expect(client.account('Nova')).toBe(account);
  expect((await store.get('Nova'))?.playerId).toBe('plr_Nova');
});

test('connectAll connects every stored account', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({ webSocketFactory: factory, connectStaggerMs: 0 });
  await client.addLogin('Nova', 'pw');
  await client.addLogin('Rex', 'pw');

  const allP = client.connectAll();
  // serve each socket as it is created
  for (const name of ['Nova', 'Rex']) {
    // wait for the next socket to appear
    while (sockets.length < (name === 'Nova' ? 1 : 2)) await new Promise((r) => setTimeout(r, 1));
    autoServe(sockets[name === 'Nova' ? 0 : 1]!, name);
  }
  const accounts = await allP;
  expect(accounts.length).toBe(2);
  expect(client.ids().sort()).toEqual(['Nova', 'Rex']);
});

test('connectAll/connectOwned report each account via onConnect as it finishes, not just at the end', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 0,
    connectBatchSize: 1,
    connectBatchWaitMs: 200, // large relative to a single connect, so Nova finishing
    // well before Rex proves onConnect fired incrementally, not only once the
    // whole batch (which would take >= 200ms here) settles.
  });
  await client.addLogin('Nova', 'pw');
  await client.addLogin('Rex', 'pw');

  const seen: string[] = [];
  const allP = client.connectAll({ onConnect: (account) => seen.push(account.id!) });

  while (sockets.length < 1) await new Promise((r) => setTimeout(r, 1));
  autoServe(sockets[0]!, 'Nova');
  // Give Nova's connect a moment to settle, well before Rex's batch-wait delay
  // (200ms) elapses — proving onConnect already fired for it.
  await new Promise((r) => setTimeout(r, 20));
  expect(seen).toEqual(['Nova']);

  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 1));
  autoServe(sockets[1]!, 'Rex');
  await allP;
  expect(seen).toEqual(['Nova', 'Rex']);
});

test('connectIds does not pause between batches at or under connectBatchSize', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 5,
    connectBatchSize: 3,
    connectBatchWaitMs: 1000, // would dominate the timing below if ever triggered
  });
  await client.addLogin('A', 'pw');
  await client.addLogin('B', 'pw');
  await client.addLogin('C', 'pw');

  const start = Date.now();
  const allP = client.connectAll();
  for (let i = 0; i < 3; i++) {
    while (sockets.length < i + 1) await new Promise((r) => setTimeout(r, 1));
    autoServe(sockets[i]!, `acct${i}`);
  }
  await allP;
  expect(Date.now() - start).toBeLessThan(500); // well under the batch pause
});

test('connectIds pauses connectBatchWaitMs between batches for a fleet over connectBatchSize', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 1,
    connectBatchSize: 2,
    connectBatchWaitMs: 150,
  });
  await client.addLogin('A', 'pw');
  await client.addLogin('B', 'pw');
  await client.addLogin('C', 'pw'); // 3rd account starts a new batch

  const allP = client.connectAll();
  const socketCreatedAt: number[] = [];
  for (let i = 0; i < 3; i++) {
    while (sockets.length < i + 1) await new Promise((r) => setTimeout(r, 1));
    socketCreatedAt.push(Date.now());
    autoServe(sockets[i]!, `acct${i}`);
  }
  await allP;

  const withinBatchGap = socketCreatedAt[1]! - socketCreatedAt[0]!;
  const acrossBatchGap = socketCreatedAt[2]! - socketCreatedAt[1]!;
  expect(withinBatchGap).toBeLessThan(100); // just the 1ms stagger, plus test scheduling slop
  expect(acrossBatchGap).toBeGreaterThanOrEqual(140); // the 150ms batch pause, not the 1ms stagger
});

test('connectAll retries a rejected handshake instead of aborting the rest of the fleet', async () => {
  const sockets: MockSocket[] = [];
  let created = 0;
  const factory = (url: string): MockSocket => {
    created++;
    // Nova's first connection attempt fails to open — simulates a 429 on the
    // WS upgrade from the per-IP connection cap (e.g. a large fleet burst).
    const s = new MockSocket(url, { failToOpen: created === 1 });
    sockets.push(s);
    return s;
  };

  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 0,
    connectRetry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
  });
  await client.addLogin('Nova', 'pw');
  await client.addLogin('Rex', 'pw');

  const allP = client.connectAll();

  // socket 0 is Nova's failed attempt (nothing to serve); socket 1 is Nova's
  // retry; socket 2 is Rex's (only attempted after Nova finally succeeds,
  // since connectIds awaits each id in turn).
  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 1));
  autoServe(sockets[1]!, 'Nova');
  while (sockets.length < 3) await new Promise((r) => setTimeout(r, 1));
  autoServe(sockets[2]!, 'Rex');

  const accounts = await allP;
  expect(accounts.length).toBe(2);
  expect(accounts.every((a) => a.authenticated)).toBe(true);
  expect(created).toBe(3); // Nova's failed attempt + Nova's retry + Rex
});

test('connect() honors retry_after when a 4003 close arrives before auth completes', async () => {
  const sockets: MockSocket[] = [];
  let created = 0;
  const factory = (url: string): MockSocket => {
    created++;
    const s = new MockSocket(url);
    sockets.push(s);
    if (created === 1) {
      // Let the WS upgrade complete normally, then simulate the server
      // closing with the connection-rate-limit code shortly after — matches
      // the documented gameserver behavior (v0.471.4): the handshake
      // succeeds, then the connection is closed with 4003 (instead of
      // hanging) while waiting for `welcome`.
      setTimeout(() => s.close(4003, 'retry_after=1'), 0);
    }
    return s;
  };

  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 0,
    // A large fallback so honoring the 1s retry_after hint is unambiguous.
    connectRetry: { maxRetries: 2, baseDelayMs: 5000, maxDelayMs: 5000 },
  });
  await client.addLogin('Nova', 'pw');

  const start = Date.now();
  const connectP = client.connect('Nova');
  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 5));
  autoServe(sockets[1]!, 'Nova');
  const account = await connectP;
  const elapsed = Date.now() - start;

  expect(account.authenticated).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(900); // honored the ~1000ms hint (some timer jitter tolerated)
  expect(elapsed).toBeLessThan(3000); // ...not the 5000ms fallback
}, 6000);

test('connect gives up after connectRetry is exhausted and does not leak a stale account', async () => {
  const factory = (url: string): MockSocket => new MockSocket(url, { failToOpen: true });
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 2 },
  });
  await client.addLogin('Nova', 'pw');

  await expect(client.connect('Nova')).rejects.toBeDefined();
  expect(client.account('Nova')).toBeUndefined();
  expect(client.ids()).toEqual([]);
});

test('connectRetry: false fails fast on a rejected handshake', async () => {
  const factory = (url: string): MockSocket => new MockSocket(url, { failToOpen: true });
  const client = new SpacemoltClient({ webSocketFactory: factory, connectRetry: false });
  await client.addLogin('Nova', 'pw');

  await expect(client.connect('Nova')).rejects.toBeDefined();
});

test('connectAll tolerates one account failing to connect', async () => {
  const sockets: MockSocket[] = [];
  let created = 0;
  const factory = (url: string): MockSocket => {
    created++;
    // The 2nd account ("Bad", by addLogin order) can never open its socket — a
    // permanent failure (bad/blocked credentials, a game-side-deleted account).
    // With connectRetry disabled it fails fast, and connectIds must skip it
    // rather than aborting the whole fleet.
    const s = new MockSocket(url, { failToOpen: created === 2 });
    sockets.push(s);
    return s;
  };
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 0,
    connectRetry: false,
  });
  await client.addLogin('Nova', 'pw');
  await client.addLogin('Bad', 'pw');
  await client.addLogin('Rex', 'pw');

  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const allP = client.connectAll();
    // connectIds awaits each id in turn: socket 0 = Nova, socket 1 = Bad
    // (fails to open, skipped), socket 2 = Rex.
    while (sockets.length < 1) await new Promise((r) => setTimeout(r, 1));
    autoServe(sockets[0]!, 'Nova');
    while (sockets.length < 3) await new Promise((r) => setTimeout(r, 1));
    autoServe(sockets[2]!, 'Rex');

    const accounts = await allP;
    expect(accounts.length).toBe(2);
    expect(client.ids().sort()).toEqual(['Nova', 'Rex']);
    expect(client.account('Bad')).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]?.[0])).toContain('Bad');
  } finally {
    console.warn = originalWarn;
  }
});

test('remove closes and forgets an account', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({ webSocketFactory: factory });
  await client.addLogin('Nova', 'pw');
  const connectP = client.connect('Nova');
  await Promise.resolve();
  autoServe(sockets[0]!, 'Nova');
  await connectP;

  await client.remove('Nova');
  expect(client.account('Nova')).toBeUndefined();
  expect(await client.credentialStore.get('Nova')).toBeUndefined();
});

// --- client-driven reconnect (a mass disconnect, e.g. a game-server restart) ---

test('reconnects after a shared disconnect are paced by connectBatchSize/connectStaggerMs, not simultaneous', async () => {
  // Regression test for a real incident: a game-server restart closed every
  // connected account's socket near-simultaneously. Each account used to
  // reconnect on its own independent timer with no coordination — this pins
  // that reconnection instead goes through the exact same batch/stagger
  // pacing as the initial connect (connectIds), not a parallel mechanism.
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 1,
    connectBatchSize: 2,
    connectBatchWaitMs: 150,
  });
  await client.addLogin('A', 'pw');
  await client.addLogin('B', 'pw');
  await client.addLogin('C', 'pw'); // 3rd account starts a new batch

  const allP = client.connectAll();
  for (let i = 0; i < 3; i++) {
    while (sockets.length < i + 1) await new Promise((r) => setTimeout(r, 1));
    autoServe(sockets[i]!, `acct${i}`);
  }
  await allP;

  const before = sockets.length;
  const reconnectedAt: number[] = [];
  // Close all three at once — the same event a mass disconnect would cause.
  for (let i = 0; i < 3; i++) sockets[i]!.close(1006, 'abnormal');

  for (let i = 0; i < 3; i++) {
    while (sockets.length < before + i + 1) await new Promise((r) => setTimeout(r, 1));
    reconnectedAt.push(Date.now());
    autoServe(sockets[before + i]!, `acct${i}`);
  }

  const withinBatchGap = reconnectedAt[1]! - reconnectedAt[0]!;
  const acrossBatchGap = reconnectedAt[2]! - reconnectedAt[1]!;
  expect(withinBatchGap).toBeLessThan(100); // just the 1ms stagger, plus test scheduling slop
  expect(acrossBatchGap).toBeGreaterThanOrEqual(140); // the 150ms batch pause, not the 1ms stagger
}, 5000);

test('onAccountConnected fires only once; onAccountReconnected fires after, with the SAME Account instance', async () => {
  // Reconnection is in place (Account.reconnectOnce), not a new instance —
  // anything holding a direct reference (e.g. a running loop) must keep
  // working transparently across a reconnect.
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({ webSocketFactory: factory, connectStaggerMs: 0 });
  await client.addLogin('Nova', 'pw');

  const connectedAccounts: Account[] = [];
  const reconnectedAccounts: Account[] = [];
  client.onAccountConnected((account) => connectedAccounts.push(account));
  client.onAccountReconnected((account) => reconnectedAccounts.push(account));

  const connectP = client.connect('Nova');
  await Promise.resolve();
  autoServe(sockets[0]!, 'Nova');
  const firstAccount = await connectP;
  expect(connectedAccounts).toEqual([firstAccount]);

  sockets[0]!.close(1006, 'abnormal');
  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 2));
  autoServe(sockets[1]!, 'Nova');

  while (reconnectedAccounts.length < 1) await new Promise((r) => setTimeout(r, 2));
  expect(reconnectedAccounts[0]).toBe(firstAccount);
  // onAccountConnected does NOT fire again — no new instance appeared.
  expect(connectedAccounts).toEqual([firstAccount]);
  expect(client.account('Nova')).toBe(firstAccount);
}, 5000);

test('a socket dropping mid-reconnect does not spawn a parallel reconnect chain', async () => {
  // Regression: handleAccountDisconnected must not enqueue a second reconnect
  // chain when the reconnect socket itself drops again before completing —
  // that drop should surface as a retry inside the one already-running
  // withConnectRetry loop, not spawn a duplicate one racing it.
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    connectStaggerMs: 0,
    connectRetry: { baseDelayMs: 1, maxDelayMs: 5, maxRetries: 5 },
  });
  await client.addLogin('Nova', 'pw');

  const reconnectedAccounts: Account[] = [];
  client.onAccountReconnected((account) => reconnectedAccounts.push(account));

  const connectP = client.connect('Nova');
  await Promise.resolve();
  autoServe(sockets[0]!, 'Nova');
  const account = await connectP;

  sockets[0]!.close(1006, 'abnormal');
  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 2));

  // Let the reconnect socket's own async "open" fire, then drop it before
  // ever serving a welcome frame — a second disconnect before auth
  // completes. This must be absorbed as a retry within the reconnect
  // attempt already running, not spawn a second, parallel one.
  await new Promise((r) => setTimeout(r, 5));
  sockets[1]!.close(1006, 'abnormal');

  // The retry (from the one reconnect chain already running) creates a
  // third socket after its backoff delay — serve it properly.
  while (sockets.length < 3) await new Promise((r) => setTimeout(r, 2));
  autoServe(sockets[2]!, 'Nova');

  while (reconnectedAccounts.length < 1) await new Promise((r) => setTimeout(r, 2));
  // Give a (buggy) duplicate chain time to also run its course before
  // asserting there wasn't one.
  await new Promise((r) => setTimeout(r, 30));
  expect(reconnectedAccounts).toEqual([account]);
  expect(sockets.length).toBe(3);
  expect(client.account('Nova')).toBe(account);
}, 5000);

test('onAccountDisconnected fires on session_replaced and does not attempt reconnection', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({ webSocketFactory: factory, connectStaggerMs: 0 });
  await client.addLogin('Nova', 'pw');

  const disconnects: Array<{ id: string; code: number | undefined }> = [];
  client.onAccountDisconnected((id, err) => disconnects.push({ id, code: err.code }));

  const connectP = client.connect('Nova');
  await Promise.resolve();
  autoServe(sockets[0]!, 'Nova');
  await connectP;

  sockets[0]!.close(4001, 'session_replaced');
  while (disconnects.length < 1) await new Promise((r) => setTimeout(r, 2));
  expect(disconnects).toEqual([{ id: 'Nova', code: 4001 }]);

  // give any (incorrect) reconnect attempt a chance to create a socket
  await new Promise((r) => setTimeout(r, 20));
  expect(sockets.length).toBe(1);
  expect(client.account('Nova')).toBeUndefined();
}, 5000);

test('a market subscription active before a disconnect is restored on the reconnected account', async () => {
  const { factory, sockets } = mockFactory();
  const client = new SpacemoltClient({ webSocketFactory: factory, connectStaggerMs: 0 });
  await client.addLogin('Nova', 'pw');

  const connectP = client.connect('Nova');
  await Promise.resolve();
  autoServe(sockets[0]!, 'Nova');
  const account = await connectP;

  sockets[0]!.onClientSend = (frame, s) => {
    if (frame.action === 'subscribe_market') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'ok', structuredContent: { base_id: 'station-1', tick: 1, items: [] } },
      });
    }
  };
  await account.subscribeMarket();
  expect(account.marketSubscribed).toBe(true);

  sockets[0]!.close(1006, 'abnormal');
  while (sockets.length < 2) await new Promise((r) => setTimeout(r, 2));
  const newSocket = sockets[1]!;
  newSocket.serverSend({ type: 'welcome', payload: welcomePayload() });
  newSocket.onClientSend = (frame, s) => {
    if (frame.action === 'login') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    } else if (frame.action === 'get_status') {
      // authenticate()'s post-login state seed — must be answered or it hangs
      // on its own queryTimeoutMs (15s default), well past this test's limit.
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'ok', structuredContent: { player: { id: 'plr_Nova', username: 'Nova' } } },
      });
    } else if (frame.action === 'subscribe_market') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            base_id: 'station-1',
            tick: 2,
            items: [{ item_id: 'reconnect_marker', price: 1, quantity: 1 }],
          },
        },
      });
    }
  };

  // Poll the actually-observable effect of the resubscribe (a book seeded
  // with the reconnect response's distinct item) rather than a proxy flag —
  // the frame being sent and the correlator settling the resulting promise
  // happen a microtask apart, so a flag set synchronously inside
  // onClientSend can flip true before subscribeMarket()'s own continuation
  // (the cache seed) has run. seed() always resets tick to 0 for a fresh
  // subscribe (see MarketCache.seed), so the item list — not tick — is what
  // distinguishes the pre-disconnect subscribe from the post-reconnect one.
  while (!account.market('station-1')?.items.has('reconnect_marker')) {
    await new Promise((r) => setTimeout(r, 2));
  }
  // reconnect is in place — client.account() still returns the SAME instance
  expect(client.account('Nova')).toBe(account);
}, 5000);
