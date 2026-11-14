import { expect, test } from 'bun:test';
import { Account, type AccountOptions, type TransportAdmissionRequest } from '../src/account.ts';
import { SpacemoltClient } from '../src/client.ts';
import { MemoryCredentialStore } from '../src/auth/credentials.ts';
import type { StoredAccount } from '../src/auth/credentials.ts';
import type { InboundFrame, WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, type MockSocket } from './mock-socket.ts';
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
      connectTimeoutMs: 20,
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
    account.close();
  }
});
