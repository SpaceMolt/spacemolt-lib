import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import { SpacemoltClient } from '../src/client.ts';
import { ClerkSource } from '../src/auth/clerk.ts';
import { MemoryCredentialStore } from '../src/auth/credentials.ts';
import type { WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0', release_date: '2026-06-20', release_notes: [], tick_rate: 5,
    current_tick: 1, server_time: 1, game_info: '', website: '', help_text: '', terms: '',
  };
}

/** A fetch stub that matches request URLs by substring and records calls. */
function mockFetch(routes: Record<string, unknown>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [key, body] of Object.entries(routes)) {
      if (url.includes(key)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404, statusText: 'Not Found' });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Auto-respond to welcome / login_token / get_status so a clerk account connects. */
function autoServeToken(socket: MockSocket, username: string): void {
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login_token') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { id: `plr_${username}`, username } } });
    } else if (frame.action === 'get_status') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: { result: 'ok', structuredContent: { player: { id: `plr_${username}`, username } } },
      });
    }
  };
}

test('ClerkSource lists owned players and mints ws-tokens with the bearer key', async () => {
  const { fetchImpl, calls } = mockFetch({
    '/api/registration-code': {
      registration_code: 'rc',
      players: [{ id: 'plr_1', username: 'Nova', empire: 'solarian', hidden: false }],
    },
    '/api/player/plr_1/ws-token': { token: 'tok_abc', expires_in: 300 },
  });
  const source = new ClerkSource({ apiKey: 'sk_test', httpBaseUrl: 'https://game.spacemolt.com/', fetchImpl });

  expect(source.httpBaseUrl).toBe('https://game.spacemolt.com'); // trailing slash stripped

  const players = await source.listPlayers();
  expect(players).toHaveLength(1);
  expect(players[0]!.username).toBe('Nova');

  const token = await source.mintWsToken('plr_1');
  expect(token).toBe('tok_abc');

  const listCall = calls.find((c) => c.url.includes('registration-code'))!;
  expect((listCall.init?.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
  const mintCall = calls.find((c) => c.url.includes('/ws-token'))!;
  expect(mintCall.init?.method).toBe('POST');
});

test('Account authenticates via clerk: mints a ws-token, then logs in with it', async () => {
  const { factory, sockets } = mockFactory();
  const { fetchImpl, calls } = mockFetch({ '/api/player/plr_1/ws-token': { token: 'tok_xyz', expires_in: 300 } });
  const account = new Account({ url: 'wss://game.spacemolt.com/ws/v2', webSocketFactory: factory, seedState: false, fetchImpl });

  const connectP = account.connect();
  const socket = sockets[0]!;
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;

  socket.onClientSend = (frame, s) => {
    if (frame.action === 'login_token') {
      s.serverSend({ type: 'logged_in', request_id: frame.request_id, payload: { player: { username: 'Nova' } } });
    }
  };
  await account.authenticate({ kind: 'clerk', apiKey: 'sk_test', playerId: 'plr_1', httpBaseUrl: 'https://game.spacemolt.com' });

  expect(account.authenticated).toBe(true);
  const sent = socket.sent.find((f) => f.action === 'login_token');
  expect(sent?.payload?.token).toBe('tok_xyz');
  expect(calls.find((c) => c.url.includes('/ws-token'))!.url).toContain('/api/player/plr_1/ws-token');
});

test('connectOwned connects every owned account via clerk (clerk creds, no passwords)', async () => {
  const { factory, sockets } = mockFactory();
  const { fetchImpl } = mockFetch({
    '/api/registration-code': {
      registration_code: 'rc',
      players: [
        { id: 'plr_1', username: 'Nova', empire: 'solarian', hidden: false },
        { id: 'plr_2', username: 'Rex', empire: 'martian', hidden: false },
      ],
    },
    '/api/player/plr_1/ws-token': { token: 'tok_1', expires_in: 300 },
    '/api/player/plr_2/ws-token': { token: 'tok_2', expires_in: 300 },
  });
  const store = new MemoryCredentialStore();
  const client = new SpacemoltClient({
    url: 'wss://game.spacemolt.com/ws/v2',
    webSocketFactory: factory,
    fetchImpl,
    clerkApiKey: 'sk_test',
    connectStaggerMs: 0,
    store,
  });

  const ownedP = client.connectOwned();
  for (let i = 0; i < 2; i++) {
    while (sockets.length < i + 1) await new Promise((r) => setTimeout(r, 1));
    autoServeToken(sockets[i]!, i === 0 ? 'Nova' : 'Rex');
  }
  const accounts = await ownedP;

  expect(accounts.length).toBe(2);
  expect(client.ids().sort()).toEqual(['Nova', 'Rex']);

  const nova = await store.get('Nova');
  expect(nova?.credentials.kind).toBe('clerk');
  expect((nova?.credentials as { apiKey: string }).apiKey).toBe('sk_test');
  expect(sockets[0]!.sent.find((f) => f.action === 'login_token')?.payload?.token).toBe('tok_1');
});

test('connectOwned applies a player filter', async () => {
  const { factory, sockets } = mockFactory();
  const { fetchImpl } = mockFetch({
    '/api/registration-code': {
      registration_code: 'rc',
      players: [
        { id: 'plr_1', username: 'Nova', empire: 'solarian', hidden: false },
        { id: 'plr_2', username: 'Ghost', empire: 'martian', hidden: true },
      ],
    },
    '/api/player/plr_1/ws-token': { token: 'tok_1', expires_in: 300 },
  });
  const client = new SpacemoltClient({
    url: 'wss://game.spacemolt.com/ws/v2',
    webSocketFactory: factory,
    fetchImpl,
    clerkApiKey: 'sk_test',
    connectStaggerMs: 0,
  });

  const ownedP = client.connectOwned({ filter: (p) => !p.hidden });
  while (sockets.length < 1) await new Promise((r) => setTimeout(r, 1));
  autoServeToken(sockets[0]!, 'Nova');
  const accounts = await ownedP;

  expect(accounts.length).toBe(1);
  expect(client.ids()).toEqual(['Nova']);
});

test('listOwnedPlayers / connectOwned require a clerk API key', async () => {
  const client = new SpacemoltClient({ url: 'wss://game.spacemolt.com/ws/v2' });
  await expect(client.listOwnedPlayers()).rejects.toThrow(/clerkApiKey/);
});
