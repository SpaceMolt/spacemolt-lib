import { expect, test } from 'bun:test';
import { Account } from '../src/account.ts';
import { MarketCache } from '../src/state/market.ts';
import { ObservationCache } from '../src/state/observation.ts';
import type {
  NotificationObservationUpdate,
  SubscribeMarketResponse,
  SubscribeObservationResponse,
} from '../src/generated/openapi/types.gen.ts';
import type { WelcomeFrame } from '../src/protocol.ts';
import { mockFactory, MockSocket } from './mock-socket.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0', release_date: '2026-06-20', release_notes: [], tick_rate: 5,
    current_tick: 1, server_time: 1, game_info: '', website: '', help_text: '', terms: '',
  };
}

async function connected(): Promise<{ account: Account; socket: MockSocket }> {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m/ws/v2', webSocketFactory: factory, seedState: false });
  const connectP = account.connect();
  const socket = sockets[0]!;
  socket.serverSend({ type: 'welcome', payload: welcomePayload() });
  await connectP;
  return { account, socket };
}

// --- event dispatch ---

test('on(type) delivers the typed payload for matching pushes', async () => {
  const { account, socket } = await connected();
  const seen: string[] = [];
  account.on('chat_message', (msg) => seen.push(`${msg.sender}:${msg.content}`));
  socket.serverSend({ type: 'chat_message', payload: { sender: 'Nova', content: 'hi', channel: 'system' } });
  socket.serverSend({ type: 'mining_yield', payload: { resource_id: 'iron_ore', quantity: 5 } });
  expect(seen).toEqual(['Nova:hi']);
});

test('on returns an unsubscribe function', async () => {
  const { account, socket } = await connected();
  let count = 0;
  const off = account.on('chat_message', () => count++);
  socket.serverSend({ type: 'chat_message', payload: { content: 'a' } });
  off();
  socket.serverSend({ type: 'chat_message', payload: { content: 'b' } });
  expect(count).toBe(1);
});

test('a throwing on(type) listener does not stop other listeners for the same frame', async () => {
  const { account, socket } = await connected();
  const seen: string[] = [];
  account.on('chat_message', () => {
    throw new Error('boom');
  });
  account.on('chat_message', (msg) => seen.push(String(msg.content)));
  socket.serverSend({ type: 'chat_message', payload: { content: 'a' } });
  expect(seen).toEqual(['a']);
});

test('a throwing on(type) listener does not stop onAny or streams for the same frame', async () => {
  const { account, socket } = await connected();
  account.on('chat_message', () => {
    throw new Error('boom');
  });
  const types: string[] = [];
  account.onAny((frame) => types.push(frame.type));
  const stream = account.events('chat_message');
  socket.serverSend({ type: 'chat_message', payload: { content: 'a' } });
  expect(types).toEqual(['chat_message']);
  const next = await stream.next();
  expect(next.value?.content).toBe('a');
});

test('onAny receives every push frame', async () => {
  const { account, socket } = await connected();
  const types: string[] = [];
  account.onAny((frame) => types.push(frame.type));
  socket.serverSend({ type: 'chat_message', payload: { content: 'a' } });
  socket.serverSend({ type: 'mining_yield', payload: { resource_id: 'x', quantity: 1 } });
  expect(types).toEqual(['chat_message', 'mining_yield']);
});

test('events(type) async-iterates buffered payloads', async () => {
  const { account, socket } = await connected();
  // Create the stream first; frames pushed before the consumer's next() are
  // buffered, not dropped.
  const stream = account.events('chat_message');
  socket.serverSend({ type: 'chat_message', payload: { content: 'one' } });
  socket.serverSend({ type: 'chat_message', payload: { content: 'two' } });

  const got: string[] = [];
  for await (const msg of stream) {
    got.push(String(msg.content));
    if (got.length === 2) break; // break calls return() -> unsubscribe
  }
  expect(got).toEqual(['one', 'two']);
});

// --- market subscription + cache ---

test('subscribeMarket seeds the book and market_update merges changed items', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'subscribe_market') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            base_id: 'earth_station',
            base_name: 'Earth Station',
            items: [
              { item_id: 'iron_ore', sell_orders: [{ price_each: 10, quantity: 5 }], buy_orders: [] },
              { item_id: 'water', sell_orders: [{ price_each: 2, quantity: 100 }], buy_orders: [] },
            ],
          },
        },
      });
    }
  };
  const baseline = await account.subscribeMarket();
  expect(baseline.base_id).toBe('earth_station');
  expect(account.market('earth_station')?.items.size).toBe(2);

  // a market_update changing only iron_ore
  socket.serverSend({
    type: 'market_update',
    payload: {
      base_id: 'earth_station',
      tick: 1600,
      items: [{ item_id: 'iron_ore', sell_orders: [{ price_each: 12, quantity: 3 }], buy_orders: [] }],
    },
  });
  const book = account.market('earth_station');
  expect(book?.tick).toBe(1600);
  expect(book?.items.get('iron_ore')?.sell_orders[0]?.price_each).toBe(12);
  expect(book?.items.get('water')?.sell_orders[0]?.quantity).toBe(100); // untouched item preserved
});

// --- observation bridges into location ---

function respondToSubscribeObservation(socket: MockSocket, nearby: SubscribeObservationResponse['nearby']): void {
  socket.onClientSend = (frame, s) => {
    if (frame.action === 'subscribe_observation') {
      s.serverSend({
        type: 'result',
        request_id: frame.request_id,
        payload: {
          result: 'ok',
          structuredContent: {
            action: 'subscribe_observation',
            poi_id: 'earth_station',
            system_id: 'sol',
            active_scan: false,
            unknown_signature: false,
            nearby,
            system_agents: [],
            cloaked_contacts: [],
          } satisfies SubscribeObservationResponse,
        },
      });
    }
  };
}

test('subscribeObservation bridges nearby-player presence into location.nearby_players', async () => {
  const { account, socket } = await connected();
  // Seed `location` first, like a real dock/jump would — the bridge is a
  // partial patch and can't stand in for a section that doesn't exist yet.
  socket.serverSend({
    type: 'action_result',
    request_id: 'seed',
    payload: { command: 'dock', tick: 1, result: { location: { poi_id: 'earth_station', docked_at: 'earth_station' } } },
  });
  expect(account.state.location?.poi_id).toBe('earth_station');

  const changedSections: string[][] = [];
  account.onStateChange((changed) => changedSections.push([...changed]));

  respondToSubscribeObservation(socket, [{ player_id: 'p1', username: 'Nova', in_combat: false }]);
  await account.subscribeObservation();

  expect(account.state.location?.nearby_players).toEqual([
    { player_id: 'p1', username: 'Nova', in_combat: false },
  ]);
  expect(account.state.location?.nearby_player_count).toBe(1);
  expect(account.state.location?.docked_at).toBe('earth_station'); // other location fields untouched
  expect(changedSections).toEqual([['location']]);

  // an observation_update push keeps location.nearby_players in sync too
  socket.serverSend({
    type: 'observation_update',
    payload: {
      poi_id: 'earth_station',
      system_id: 'sol',
      tick: 5,
      unknown_signature: false,
      nearby_changed: [{ player_id: 'p2', username: 'Rex', in_combat: true }],
      nearby_departed: ['p1'],
    } satisfies NotificationObservationUpdate,
  });

  expect(account.state.location?.nearby_players).toEqual([
    { player_id: 'p2', username: 'Rex', in_combat: true },
  ]);
  expect(account.state.location?.nearby_player_count).toBe(1);
});

test('the observation bridge does not touch location before it has been seeded', async () => {
  const { account, socket } = await connected();
  respondToSubscribeObservation(socket, [{ player_id: 'p1', username: 'Nova', in_combat: false }]);

  await account.subscribeObservation();

  expect(account.state.location).toBeUndefined();
  expect(account.observation()?.nearby.size).toBe(1); // the separate observation cache still has it
});

// --- observation cache unit ---

test('ObservationCache merges presence changes and departures', () => {
  const cache = new ObservationCache();
  cache.seed({
    action: 'subscribe_observation',
    active_scan: false,
    unknown_signature: false,
    poi_id: 'earth_station',
    system_id: 'sol',
    nearby: [{ player_id: 'p1', username: 'Nova', in_combat: false }],
    system_agents: [],
    cloaked_contacts: [],
  } satisfies SubscribeObservationResponse);
  expect(cache.current()?.nearby.size).toBe(1);

  cache.applyUpdate({
    poi_id: 'earth_station',
    system_id: 'sol',
    tick: 1700,
    unknown_signature: false,
    nearby_changed: [{ player_id: 'p2', username: 'Rex', in_combat: true }],
    nearby_departed: ['p1'],
  } satisfies NotificationObservationUpdate);
  const view = cache.current();
  expect(view?.nearby.has('p1')).toBe(false);
  expect(view?.nearby.get('p2')?.username).toBe('Rex');
  expect(view?.tick).toBe(1700);
});

test('MarketCache.drop removes a base book', () => {
  const cache = new MarketCache();
  cache.seed({
    action: 'subscribe_market',
    base_id: 'b1',
    base_name: 'B1',
    items: [{ item_id: 'x', sell_orders: [], buy_orders: [] }],
  } satisfies SubscribeMarketResponse);
  expect(cache.bases()).toEqual(['b1']);
  cache.drop('b1');
  expect(cache.book('b1')).toBeUndefined();
});
