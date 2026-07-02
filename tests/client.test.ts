import { expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
