import { expect, test } from 'bun:test';
import { Account, type AccountOptions, type TransportAdmissionRequest } from '../src/account.ts';
import { SpacemoltClient } from '../src/client.ts';
import { MemoryCredentialStore } from '../src/auth/credentials.ts';
import type { StoredAccount } from '../src/auth/credentials.ts';
import type { InboundFrame, WelcomeFrame } from '../src/protocol.ts';
import { ConnectionClosedError } from '../src/errors.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';
import { requireValue } from './require-value.ts';

const welcome: WelcomeFrame['payload'] = {
  version: 'test',
  release_date: 'today',
  release_notes: [],
  tick_rate: 10,
  current_tick: 1,
  server_time: 1,
  game_info: '',
  website: '',
  help_text: '',
  terms: '',
};

function wire(serve?: (frame: InboundFrame, socket: MockSocket) => void) {
  const { factory, sockets } = mockFactory();
  return {
    sockets,
    factory: (url: string) => {
      const socket = factory(url) as MockSocket;
      socket.onClientSend =
        serve ??
        ((frame, s) => {
          if (frame.action === 'login' || frame.action === 'login_token')
            s.serverSend({ type: 'logged_in', payload: {} });
          else
            s.serverSend({
              type: 'result',
              request_id: frame.request_id,
              payload: { result: 'ok', structuredContent: { player: { id: 'player', username: 'pilot' } } },
            });
        });
      queueMicrotask(() => socket.serverSend({ type: 'welcome', payload: welcome }));
      return socket;
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error('Expected SDK progress did not occur');
}

/** `wire`, plus the time each socket was created. */
function timedWire(serve?: (frame: InboundFrame, socket: MockSocket) => void) {
  const w = wire(serve);
  const opened: number[] = [];
  return {
    ...w,
    opened,
    factory: (url: string) => {
      opened.push(performance.now());
      return w.factory(url);
    },
  };
}

/** The most socket opens that fall inside any `windowMs` span. */
function maxInWindow(times: number[], windowMs: number): number {
  return Math.max(0, ...times.map((start) => times.filter((t) => t >= start && t < start + windowMs).length));
}

function gate() {
  const entries: { request: TransportAdmissionRequest; release: () => void }[] = [];
  return {
    entries,
    enter: (request: TransportAdmissionRequest) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        request.signal.addEventListener('abort', abort, { once: true });
        entries.push({
          request,
          release: () => {
            request.signal.removeEventListener('abort', abort);
            request.signal.throwIfAborted();
            resolve();
          },
        });
        if (request.signal.aborted) abort();
      }),
  };
}

test('socket scheduling exposes session identity and close cancels admission before any socket opens', async () => {
  const w = wire(),
    g = gate();
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    connectRetry: false,
    seedState: false,
    scheduleOpen: async (request, open) => {
      await g.enter(request);
      await open();
    },
  });
  await client.addLogin('pilot', 'fixture');
  const connected = client.connect('pilot').catch((error: unknown) => error);
  await until(() => g.entries.length === 1);
  const entry = requireValue(g.entries[0]);
  expect(entry.request.accountId).toBe('pilot');
  expect(entry.request.sessionId).toBeString();
  expect(Object.keys(entry.request).sort()).toEqual(['accountId', 'sessionId', 'signal']);
  await client.cancelConnection('pilot');
  expect(await connected).toBeInstanceOf(Error);
  expect(entry.request.signal.aborted).toBe(true);
  expect(w.sockets).toHaveLength(0);
  expect(() => entry.release()).toThrow();
});

test('send admission excludes scheduling time from query, auth and mutation deadlines; ACK is not completion', async () => {
  const w = wire((frame, socket) => {
    if (frame.action === 'login') socket.serverSend({ type: 'logged_in', payload: {} });
    else
      socket.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload:
          frame.action === 'mine'
            ? { result: 'queued', structuredContent: { pending: true, command: 'mine' } }
            : { result: 'ok' },
      });
  });
  const g = gate();
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    queryTimeoutMs: 10,
    connectTimeoutMs: 10,
    fastMutationTimeoutMs: 1000,
    scheduleSend: async (request, send) => {
      await g.enter(request);
      send();
    },
  });
  await account.connect();
  try {
    const login = account.login({ username: 'pilot', password: 'fixture' });
    await until(() => g.entries.length === 1);
    await Bun.sleep(25);
    requireValue(g.entries[0]).release();
    await login;
    const query = account.query('spacemolt', 'get_status');
    await until(() => g.entries.length === 2);
    await Bun.sleep(25);
    requireValue(g.entries[1]).release();
    await query;
    let ack = false,
      done = false;
    const mutation = account
      .mutate(
        'spacemolt',
        'mine',
        undefined,
        () => {
          ack = true;
        },
        'mine',
      )
      .then(() => {
        done = true;
      });
    await until(() => g.entries.length === 3);
    await Bun.sleep(25);
    expect(ack).toBe(false);
    requireValue(g.entries[2]).release();
    await until(() => ack);
    expect(done).toBe(false);
    requireValue(w.sockets[0]).serverSend({
      type: 'action_result',
      request_id: 'mine',
      payload: { command: 'mine', tick: 2, result: {} },
    });
    await mutation;
    expect(done).toBe(true);
    expect(new Set(g.entries.map((entry) => entry.request.sessionId)).size).toBe(1);
  } finally {
    account.close();
  }
});

test('close cancels queued query/mutation sends, releases credentials and fences old account disposal', async () => {
  const w = wire(),
    g = gate(),
    store = new MemoryCredentialStore();
  const client = new SpacemoltClient({
    store,
    seedState: false,
    webSocketFactory: w.factory,
    reconnect: false,
    connectRetry: false,
    serializeMutations: false,
    scheduleSend: async (request, send) => {
      if (request.tool !== 'spacemolt_auth') await g.enter(request);
      send();
    },
  });
  await client.addLogin('pilot', 'fixture');
  const old = await client.connect('pilot');
  const results = Promise.allSettled([old.query('spacemolt', 'get_status'), old.mutate('spacemolt', 'mine')]);
  await until(() => g.entries.length === 2);
  await client.cancelConnection('pilot');
  expect((await results).every((result) => result.status === 'rejected')).toBe(true);
  expect(g.entries.every((entry) => entry.request.signal.aborted)).toBe(true);
  expect((await store.get('pilot'))?.credentials.kind).toBe('login');
  const replacement = await client.connect('pilot');
  client.releaseAccount(old);
  expect(client.account('pilot')).toBe(replacement);
  expect(replacement.authenticated).toBe(true);
  expect(w.sockets.flatMap((socket) => socket.sent).every((frame) => frame.tool === 'spacemolt_auth')).toBe(true);
  client.closeAll();
});

test('duplicate connects share one authenticated candidate and early observers see seed progress', async () => {
  const w = wire(),
    events: string[] = [];
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    connectRetry: false,
    onAccountCreated: (account) => {
      events.push('created');
      account.onStateChange(() => events.push('seed'));
      throw new Error('observer failure');
    },
    onConnectionStage: (_account, stage) => {
      events.push(stage);
      throw new Error('observer failure');
    },
  });
  client.onAccountConnected(() => events.push('connected'));
  await client.addLogin('pilot', 'fixture');
  const [a, b] = await Promise.all([client.connect('pilot'), client.connect('pilot')]);
  expect(a).toBe(b);
  expect(a.authenticated).toBe(true);
  expect(w.sockets).toHaveLength(1);
  expect(events).toEqual(['created', 'connection_open', 'authentication', 'seed', 'authenticated', 'connected']);
  client.closeAll();
});

test('cancelled host-queued connection cannot construct a late socket or replace a new candidate', async () => {
  const w = wire();
  let queued: (() => Promise<Account>) | undefined;
  let first = true;
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    scheduleConnection: (id, attempt) => {
      expect(id).toBe('pilot');
      if (!first) return attempt();
      first = false;
      queued = attempt as () => Promise<Account>;
      return new Promise(() => {});
    },
  });
  await client.addLogin('pilot', 'fixture');
  const pending = client.connect('pilot').catch((error: unknown) => error);
  await until(() => queued !== undefined);
  await client.cancelConnection('pilot');
  expect(await pending).toBeInstanceOf(Error);
  expect(w.sockets).toHaveLength(0);
  const replacement = await client.connect('pilot');
  expect(() => requireValue(queued)()).toThrow();
  expect(client.account('pilot')).toBe(replacement);
  expect(w.sockets).toHaveLength(1);
  client.closeAll();
});

test('cancellation interrupts SDK connection retry backoff without a replacement socket', async () => {
  const w = wire((frame, socket) => {
    if (frame.action === 'login')
      socket.serverSend({ type: 'error', payload: { code: 'unavailable', message: 'retry' } });
  });
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: { maxRetries: 10, baseDelayMs: 10000 },
  });
  await client.addLogin('pilot', 'fixture');
  const pending = client.connect('pilot').catch((error: unknown) => error);
  await until(() => w.sockets.length === 1 && client.account('pilot') === undefined);
  await client.cancelConnection('pilot');
  expect(await pending).toBeInstanceOf(Error);
  expect(w.sockets).toHaveLength(1);
});

test('a cancelled candidate cannot publish after slow credential persistence or erase its replacement', async () => {
  const paused = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let hold = true;
  class SlowStore extends MemoryCredentialStore {
    override async put(account: StoredAccount): Promise<void> {
      if (account.playerId && hold) {
        hold = false;
        entered.resolve();
        await paused.promise;
      }
      await super.put(account);
    }
  }
  const w = wire(),
    connected: Account[] = [];
  const client = new SpacemoltClient({ store: new SlowStore(), webSocketFactory: w.factory, connectRetry: false });
  client.onAccountConnected((account) => connected.push(account));
  await client.addLogin('pilot', 'fixture');
  const old = client.connect('pilot').catch((error: unknown) => error);
  await entered.promise;
  await client.cancelConnection('pilot');
  expect(await old).toBeInstanceOf(Error);
  const replacement = await client.connect('pilot');
  paused.resolve();
  await Bun.sleep(0);
  expect(connected).toEqual([replacement]);
  expect(client.account('pilot')).toBe(replacement);
  expect(replacement.authenticated).toBe(true);
  client.closeAll();
});

test('one slow authentication does not block later paced starts; bulk errors identify the failed account', async () => {
  const w = wire((frame, socket) => {
    if (frame.payload?.username === 'fast') socket.serverSend({ type: 'logged_in', payload: {} });
  });
  const failures: string[] = [];
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    connectStaggerMs: 1,
    connectBatchSize: 0,
  });
  await client.addLogin('slow', 'fixture');
  await client.addLogin('fast', 'fixture');
  const bulk = client.connectAll({ onError: (id) => failures.push(id) });
  await until(() => client.account('fast')?.authenticated === true);
  expect(client.account('slow')?.authenticated).toBe(false);
  requireValue(w.sockets[0]).serverSend({ type: 'error', payload: { code: 'unavailable', message: 'retry later' } });
  expect((await bulk).map((account) => account.id)).toEqual(['fast']);
  expect(failures).toEqual(['slow']);
  client.closeAll();
});

test('the host connection scheduler admits every real SDK retry separately', async () => {
  let attempts = 0,
    admissions = 0;
  const w = wire((_frame, socket) => {
    if (++attempts === 1) socket.serverSend({ type: 'error', payload: { code: 'unavailable', message: 'retry' } });
    else socket.serverSend({ type: 'logged_in', payload: {} });
  });
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: { maxRetries: 1, baseDelayMs: 0 },
    scheduleConnection: (_id, attempt) => {
      admissions++;
      return attempt();
    },
  });
  await client.addLogin('pilot', 'fixture');
  await client.connect('pilot');
  expect(admissions).toBe(2);
  expect(w.sockets).toHaveLength(2);
  client.closeAll();
});

test('registration uses host connection/send hooks and stores generated credentials', async () => {
  const admitted: string[] = [],
    sent: string[] = [];
  const store = new MemoryCredentialStore();
  const w = wire((frame, socket) => {
    socket.serverSend({ type: 'registered', payload: { player_id: 'player', password: 'generated-fixture' } });
    socket.serverSend({ type: 'logged_in', payload: {} });
    expect(frame.action).toBe('register');
  });
  const client = new SpacemoltClient({
    store,
    seedState: false,
    webSocketFactory: w.factory,
    scheduleConnection: (id, attempt) => {
      admitted.push(id);
      return attempt();
    },
    scheduleSend: async (request, send) => {
      sent.push(request.action);
      send();
    },
  });
  const { result } = await client.register({ username: 'pilot', empire: 'solarian', registration_code: 'fixture' });
  expect(admitted).toEqual(['pilot']);
  expect(sent).toEqual(['register']);
  expect(result.password).toBe('generated-fixture');
  expect((await store.get('pilot'))?.credentials).toEqual({
    kind: 'login',
    username: 'pilot',
    password: 'generated-fixture',
  });
  client.closeAll();
});

test('automatic rate-limit retries cross send admission again', async () => {
  let attempts = 0;
  const admitted: string[] = [];
  const w = wire((frame, socket) => {
    if (frame.action === 'login') socket.serverSend({ type: 'logged_in', payload: {} });
    else if (++attempts === 1)
      socket.serverSend({
        type: 'error',
        request_id: frame.request_id,
        payload: { code: 'rate_limited', message: 'Retry in 0 seconds.', details: { retry_after: 0 } },
      });
    else socket.serverSend({ type: 'result', request_id: frame.request_id, payload: { result: 'ok' } });
  });
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    maxRateLimitRetries: 1,
    scheduleSend: async (request, send) => {
      admitted.push(request.action);
      send();
    },
  });
  await account.connect();
  await account.login({ username: 'pilot', password: 'fixture' });
  await account.query('spacemolt', 'get_status');
  expect(admitted).toEqual(['login', 'get_status', 'get_status']);
  account.close();
});

test('socket replacement changes session identity and cancels queued work on the old socket', async () => {
  const opens: TransportAdmissionRequest[] = [];
  const g = gate(),
    w = wire();
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    credentials: () => ({ kind: 'login', username: 'pilot', password: 'fixture' }),
    scheduleOpen: async (request, open) => {
      opens.push(request);
      await open();
    },
    scheduleSend: async (request, send) => {
      if (request.tool !== 'spacemolt_auth') await g.enter(request);
      send();
    },
  });
  await account.connect();
  await account.login({ username: 'pilot', password: 'fixture' });
  const pending = account.query('spacemolt', 'get_status').catch((error: unknown) => error);
  await until(() => g.entries.length === 1);
  await account.reconnectOnce();
  expect(await pending).toBeInstanceOf(Error);
  expect(requireValue(opens[0]).signal.aborted).toBe(true);
  expect(requireValue(opens[1]).sessionId).not.toBe(requireValue(opens[0]).sessionId);
  expect(w.sockets.flatMap((socket) => socket.sent).map((frame) => frame.action)).toEqual(['login', 'login']);
  account.close();
});

test('managed accounts forward maxRateLimitRetries=0 instead of silently retrying', async () => {
  let commands = 0;
  const w = wire((frame, socket) => {
    if (frame.action === 'login') socket.serverSend({ type: 'logged_in', payload: {} });
    else {
      commands++;
      socket.serverSend({
        type: 'error',
        request_id: frame.request_id,
        payload: { code: 'rate_limited', message: 'Retry in 0 seconds.', details: { retry_after: 0 } },
      });
    }
  });
  const client = new SpacemoltClient({ seedState: false, webSocketFactory: w.factory, maxRateLimitRetries: 0 });
  await client.addLogin('pilot', 'fixture');
  const account = await client.connect('pilot');
  await expect(account.query('spacemolt', 'get_status')).rejects.toMatchObject({ code: 'rate_limited' });
  expect(commands).toBe(1);
  client.closeAll();
});

test('Clerk token minting honors the account connect deadline and deliberate close', async () => {
  for (const close of [false, true]) {
    let signal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = Object.assign(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }),
        );
      },
      { preconnect: fetch.preconnect },
    );
    const w = wire();
    const options: AccountOptions = {
      seedState: false,
      webSocketFactory: w.factory,
      // On the close pass the deadline is far beyond the test timeout, so only
      // the close signal can settle the mint.
      connectTimeoutMs: close ? 60_000 : 20,
      fetchImpl,
      maxRateLimitRetries: 0,
    };
    const account = new Account(options);
    await account.connect();
    const auth = account
      .authenticate({ kind: 'clerk', apiKey: 'fixture', playerId: 'player', httpBaseUrl: 'https://game.test' })
      .catch((error: unknown) => error);
    await until(() => signal !== undefined);
    if (close) account.close();
    expect(await auth).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    if (close) expect(signal?.reason).toBeInstanceOf(ConnectionClosedError);
    else expect(signal?.reason).toMatchObject({ name: 'TimeoutError' });
    account.close();
  }
});

// --- start pacing: one sliding window shared by every paced socket open ---

test('connect retries each take their own start slot inside the batch window', async () => {
  const failedOnce = new Set<unknown>();
  const w = timedWire((frame, socket) => {
    const username = frame.payload?.username;
    if (failedOnce.has(username)) socket.serverSend({ type: 'logged_in', payload: {} });
    else {
      failedOnce.add(username);
      socket.serverSend({ type: 'error', payload: { code: 'unavailable', message: 'retry' } });
    }
  });
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectStaggerMs: 1,
    connectBatchSize: 2,
    connectBatchWaitMs: 200,
    connectRetry: { maxRetries: 1, baseDelayMs: 1 },
  });
  await client.addLogin('a', 'fixture');
  await client.addLogin('b', 'fixture');
  const accounts = await client.connectAll();
  expect(accounts.map((account) => account.id).sort()).toEqual(['a', 'b']);
  expect(w.opened).toHaveLength(4);
  // Unpaced retries would open two more sockets within a few ms of the first two.
  expect(maxInWindow(w.opened, 180)).toBe(2);
  client.closeAll();
});

test('the batch window slides: starts from an earlier bulk call still count', async () => {
  const w = timedWire();
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    connectStaggerMs: 0,
    connectBatchSize: 2,
    connectBatchWaitMs: 200,
  });
  await client.addLogin('a', 'fixture');
  await client.connectAll();
  await Bun.sleep(150);
  for (const id of ['b', 'c', 'd']) await client.addLogin(id, 'fixture');
  const accounts = await client.connectAll();
  expect(accounts.map((account) => account.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(w.opened).toHaveLength(4);
  // Expected opens: a@0, b@150, c@200, d@350. A count reset at the second
  // call would put b and c together inside a's window.
  expect(maxInWindow(w.opened, 180)).toBe(2);
  client.closeAll();
});

test('the start budget persists across separate connectAll calls', async () => {
  const w = timedWire();
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    connectStaggerMs: 0,
    connectBatchSize: 2,
    connectBatchWaitMs: 250,
  });
  await client.addLogin('a', 'fixture');
  await client.addLogin('b', 'fixture');
  await client.connectAll();
  await client.addLogin('c', 'fixture');
  await client.connectAll();
  expect(w.opened).toHaveLength(3);
  // c must wait for a's slot to leave the 250ms window; a reset budget opens it at once.
  expect(requireValue(w.opened[2]) - requireValue(w.opened[0])).toBeGreaterThanOrEqual(200);
  client.closeAll();
});

test('closeAll cancels connects still waiting for a start slot', async () => {
  const w = wire();
  const connected: (string | undefined)[] = [],
    failures: string[] = [];
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    connectStaggerMs: 0,
    connectBatchSize: 1,
    connectBatchWaitMs: 300,
  });
  client.onAccountConnected((account) => connected.push(account.id));
  for (const id of ['a', 'b', 'c']) await client.addLogin(id, 'fixture');
  const bulk = client.connectAll({ onError: (id) => failures.push(id) });
  await until(() => client.account('a')?.authenticated === true);
  client.closeAll();
  expect(await bulk).toHaveLength(1);
  await Bun.sleep(400);
  expect(w.sockets).toHaveLength(1);
  expect(client.accounts()).toEqual([]);
  expect(connected).toEqual(['a']);
  expect(failures.sort()).toEqual(['b', 'c']);
});

test('cancelConnection cancels one connect still waiting for a start slot', async () => {
  const w = wire();
  const failures: string[] = [];
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    connectStaggerMs: 0,
    connectBatchSize: 1,
    connectBatchWaitMs: 250,
  });
  for (const id of ['a', 'b', 'c']) await client.addLogin(id, 'fixture');
  const bulk = client.connectAll({ onError: (id) => failures.push(id) });
  await until(() => client.account('a')?.authenticated === true);
  await client.cancelConnection('c');
  expect((await bulk).map((account) => account.id).sort()).toEqual(['a', 'b']);
  // c's slot would have come at ~500ms.
  await Bun.sleep(350);
  expect(w.sockets).toHaveLength(2);
  expect(client.ids().sort()).toEqual(['a', 'b']);
  expect(failures).toEqual(['c']);
  client.closeAll();
});

// --- registration under host scheduling ---

test('register held by the host connection scheduler is cancelled by closeAll or cancelConnection', async () => {
  for (const cancel of ['closeAll', 'cancelConnection'] as const) {
    const w = wire();
    const connected: Account[] = [];
    let held: (() => Promise<unknown>) | undefined;
    const client = new SpacemoltClient({
      webSocketFactory: w.factory,
      seedState: false,
      scheduleConnection: (_id, attempt) => {
        held = attempt;
        return new Promise<never>(() => {});
      },
    });
    client.onAccountConnected((account) => connected.push(account));
    const pending = client
      .register({ username: 'pilot', empire: 'solarian', registration_code: 'fixture' })
      .catch((error: unknown) => error);
    await until(() => held !== undefined);
    if (cancel === 'closeAll') client.closeAll();
    else await client.cancelConnection('pilot');
    expect(await pending).toBeInstanceOf(Error);
    expect(() => requireValue(held)()).toThrow();
    await Bun.sleep(0);
    expect(w.sockets).toHaveLength(0);
    expect(connected).toEqual([]);
    expect(client.account('pilot')).toBeUndefined();
    expect(await client.credentialStore.get('pilot')).toBeUndefined();
  }
});

test('register rejects while a connect for the same id is pending', async () => {
  const w = wire();
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    scheduleConnection: () => new Promise<never>(() => {}),
  });
  await client.addLogin('pilot', 'fixture');
  const pending = client.connect('pilot').catch((error: unknown) => error);
  await expect(
    client.register({ username: 'pilot', empire: 'solarian', registration_code: 'fixture' }),
  ).rejects.toThrow('already connecting or connected');
  client.closeAll();
  expect(await pending).toBeInstanceOf(Error);
  expect(w.sockets).toHaveLength(0);
});

// --- reconnect and candidate identity ---

test('a released account in reconnect backoff does not block reconnects of its replacement', async () => {
  const w = wire();
  let created = 0;
  const factory = (url: string) => {
    // Socket 1 is the first account's reconnect attempt: it fails, so that
    // chain sits in a long backoff.
    if (++created === 2) return new MockSocket(url, { failToOpen: true });
    return w.factory(url);
  };
  const reconnected: Account[] = [];
  const client = new SpacemoltClient({
    webSocketFactory: factory,
    seedState: false,
    connectStaggerMs: 0,
    connectRetry: { maxRetries: 5, baseDelayMs: 10_000 },
  });
  client.onAccountReconnected((account) => reconnected.push(account));
  await client.addLogin('pilot', 'fixture');
  const first = await client.connect('pilot');
  requireValue(w.sockets[0]).close(1006, 'dropped');
  await until(() => created === 2);
  client.releaseAccount(first);
  const second = await client.connect('pilot');
  expect(second).not.toBe(first);
  requireValue(w.sockets[1]).close(1006, 'dropped');
  await until(() => reconnected.length === 1);
  expect(reconnected).toEqual([second]);
  expect(second.authenticated).toBe(true);
  expect(created).toBe(4);
  client.closeAll();
});

test('a terminal close during the initial connect is not retried', async () => {
  for (const afterLogin of [false, true]) {
    const w = wire((frame, socket) => {
      if (frame.action !== 'login') return;
      if (afterLogin) socket.serverSend({ type: 'logged_in', payload: {} });
      socket.close(4001, 'session_replaced');
    });
    const client = new SpacemoltClient({
      webSocketFactory: w.factory,
      seedState: false,
      connectRetry: { maxRetries: 3, baseDelayMs: 0 },
    });
    await client.addLogin('pilot', 'fixture');
    const error = await client.connect('pilot').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionClosedError);
    expect(error).toMatchObject({ code: 4001 });
    expect(w.sockets).toHaveLength(1);
    expect(client.account('pilot')).toBeUndefined();
    client.closeAll();
  }
});

test('releasing a stale account does not cancel a newer candidate for the same id', async () => {
  const w = wire(),
    g = gate();
  let opens = 0;
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    reconnect: false,
    scheduleOpen: async (request, open) => {
      if (++opens > 1) await g.enter(request);
      await open();
    },
  });
  await client.addLogin('pilot', 'fixture');
  const stale = await client.connect('pilot');
  requireValue(w.sockets[0]).close(1006, 'dropped');
  expect(client.account('pilot')).toBeUndefined();
  const newer = client.connect('pilot');
  await until(() => g.entries.length === 1);
  const candidate = requireValue(client.account('pilot'));
  client.releaseAccount(stale);
  const entry = requireValue(g.entries[0]);
  expect(entry.request.signal.aborted).toBe(false);
  expect(client.account('pilot')).toBe(candidate);
  entry.release();
  expect(await newer).toBe(candidate);
  expect(candidate.authenticated).toBe(true);
  client.closeAll();
});

test('onAccountCreated fires for a candidate that fails authentication', async () => {
  const w = wire((frame, socket) => {
    if (frame.action === 'login')
      socket.serverSend({ type: 'error', payload: { code: 'invalid_credentials', message: 'bad password' } });
  });
  const created: Account[] = [];
  const client = new SpacemoltClient({
    webSocketFactory: w.factory,
    seedState: false,
    connectRetry: false,
    onAccountCreated: (account) => created.push(account),
  });
  await client.addLogin('pilot', 'fixture');
  await expect(client.connect('pilot')).rejects.toBeDefined();
  expect(created).toHaveLength(1);
  expect(requireValue(created[0]).id).toBe('pilot');
  expect(client.account('pilot')).toBeUndefined();
});

test('remove during a slow credential write leaves no stored credentials', async () => {
  const paused = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let hold = true;
  class SlowStore extends MemoryCredentialStore {
    override async put(account: StoredAccount): Promise<void> {
      if (account.playerId && hold) {
        hold = false;
        entered.resolve();
        await paused.promise;
      }
      await super.put(account);
    }
  }
  const store = new SlowStore();
  const client = new SpacemoltClient({ store, webSocketFactory: wire().factory, connectRetry: false });
  await client.addLogin('pilot', 'fixture');
  const connecting = client.connect('pilot').catch((error: unknown) => error);
  await entered.promise;
  const removed = client.remove('pilot');
  await Bun.sleep(5);
  paused.resolve();
  await removed;
  expect(await connecting).toBeInstanceOf(Error);
  expect(await store.get('pilot')).toBeUndefined();
  expect(client.account('pilot')).toBeUndefined();
});

// --- Account host hooks fail closed ---

/** Login, a mutation that queues then settles, and an ok result for anything else. */
function serveMutations(frame: InboundFrame, socket: MockSocket): void {
  if (frame.action === 'login') socket.serverSend({ type: 'logged_in', payload: {} });
  else if (frame.action === 'mine') {
    socket.serverSend({
      type: 'result',
      request_id: frame.request_id,
      payload: { result: 'queued', structuredContent: { pending: true, command: 'mine' } },
    });
    socket.serverSend({
      type: 'action_result',
      request_id: frame.request_id,
      payload: { command: 'mine', tick: 2, result: { mined: 1 } },
    });
  } else socket.serverSend({ type: 'result', request_id: frame.request_id, payload: { result: 'ok' } });
}

test('a scheduleSend that never calls send() rejects promptly and does not wedge the mutation lane', async () => {
  const w = wire(serveMutations);
  const skip = new Set(['get_status', 'mine']);
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    queryTimeoutMs: 60_000,
    fastMutationTimeoutMs: 60_000,
    scheduleSend: async (request, send) => {
      if (!skip.delete(request.action)) send();
    },
  });
  await account.connect();
  try {
    await account.login({ username: 'pilot', password: 'fixture' });
    await expect(account.query('spacemolt', 'get_status')).rejects.toThrow('without running');
    await expect(account.mutate('spacemolt', 'mine')).rejects.toThrow('without running');
    await account.mutate('spacemolt', 'mine');
    expect(requireValue(w.sockets[0]).sent.map((frame) => frame.action)).toEqual(['login', 'mine']);
  } finally {
    account.close();
  }
});

test('a scheduleSend that calls send() twice gets an error and sends one frame', async () => {
  const w = wire(serveMutations);
  let second: unknown;
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    scheduleSend: async (request, send) => {
      send();
      if (request.action !== 'get_status') return;
      try {
        send();
      } catch (error) {
        second = error;
      }
    },
  });
  await account.connect();
  try {
    await account.login({ username: 'pilot', password: 'fixture' });
    await account.query('spacemolt', 'get_status');
    expect(second).toBeInstanceOf(Error);
    expect(requireValue(w.sockets[0]).sent.map((frame) => frame.action)).toEqual(['login', 'get_status']);
  } finally {
    account.close();
  }
});

test('a scheduleSend that throws after send() keeps the real mutation result', async () => {
  const w = wire(serveMutations);
  const originalWarn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    scheduleSend: async (request, send) => {
      send();
      if (request.action === 'mine') throw new Error('host bookkeeping failed');
    },
  });
  try {
    await account.connect();
    await account.login({ username: 'pilot', password: 'fixture' });
    const result = await account.mutate('spacemolt', 'mine');
    expect(JSON.stringify(result)).toContain('mined');
    expect(warnings).toHaveLength(1);
  } finally {
    console.warn = originalWarn;
    account.close();
  }
});

test('a scheduleOpen that never calls open() rejects connect promptly', async () => {
  const w = wire();
  const account = new Account({
    seedState: false,
    webSocketFactory: w.factory,
    connectTimeoutMs: 60_000,
    scheduleOpen: async () => {},
  });
  try {
    await expect(account.connect()).rejects.toThrow('without running');
    expect(w.sockets).toHaveLength(0);
  } finally {
    account.close();
  }
});

test('session ids fall back when crypto.randomUUID is unavailable', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  const sessionIds: string[] = [];
  const accounts: Account[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const account = new Account({
        seedState: false,
        webSocketFactory: wire().factory,
        scheduleOpen: async (request, open) => {
          sessionIds.push(request.sessionId);
          await open();
        },
      });
      accounts.push(account);
      await account.connect();
    }
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
    else Reflect.deleteProperty(globalThis.crypto, 'randomUUID');
    for (const account of accounts) account.close();
  }
  expect(typeof globalThis.crypto.randomUUID).toBe('function');
  expect(sessionIds).toHaveLength(2);
  expect(sessionIds.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(new Set(sessionIds).size).toBe(2);
});
