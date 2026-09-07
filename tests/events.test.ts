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
import { mockFactory, type MockSocket } from './mock-socket.ts';
import { requireValue } from './require-value.ts';

function welcomePayload(): WelcomeFrame['payload'] {
  return {
    version: '0.452.0',
    release_date: '2026-06-20',
    release_notes: [],
    tick_rate: 5,
    current_tick: 1,
    server_time: 1,
    game_info: '',
    website: '',
    help_text: '',
    terms: '',
  };
}

async function connected(): Promise<{ account: Account; socket: MockSocket }> {
  const { factory, sockets } = mockFactory();
  const account = new Account({ url: 'ws://m/ws/v2', webSocketFactory: factory, seedState: false });
  const connectP = account.connect();
  const socket = requireValue(sockets[0], 'expected socket to be created synchronously');
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

test('subscription helpers reject responses without structured content', async () => {
  const { account, socket } = await connected();
  socket.onClientSend = (frame, server) => {
    server.serverSend({
      type: 'result',
      request_id: frame.request_id,
      payload: { result: 'missing structured content' },
    });
  };

  await expect(account.subscribeMarket()).rejects.toMatchObject({ code: 'invalid_response' });
  await expect(account.subscribeObservation()).rejects.toMatchObject({ code: 'invalid_response' });
  expect(account.market('earth_station')).toBeUndefined();
  expect(account.observation()).toBeNull();
});

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

test('market() stops serving a book once the account undocks — the server drops the subscription silently on move, with no push telling the client', async () => {
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
            items: [{ item_id: 'iron_ore', sell_orders: [{ price_each: 10, quantity: 5 }], buy_orders: [] }],
          },
        },
      });
    }
  };
  await account.subscribeMarket();
  expect(account.market('earth_station')?.items.size).toBe(1);
  expect(account.marketSubscribed).toBe(true);

  // Simulate an undock mutation's action_result delta — no market_update or
  // unsubscribe ack is ever sent for this by the server.
  socket.serverSend({
    type: 'action_result',
    request_id: 'undock-1',
    payload: { command: 'undock', tick: 2, result: { location: { docked_at: null } } },
  });

  expect(account.market('earth_station')).toBeUndefined();
  expect(account.marketSubscribed).toBe(false);
});

test('market() keeps serving the book across a state update that leaves docked_at unchanged', async () => {
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
            items: [{ item_id: 'iron_ore', sell_orders: [{ price_each: 10, quantity: 5 }], buy_orders: [] }],
          },
        },
      });
    }
  };
  await account.subscribeMarket();

  socket.serverSend({
    type: 'action_result',
    request_id: 'sell-1',
    payload: { command: 'sell', tick: 2, result: { location: { docked_at: 'earth_station' }, credits: 500 } },
  });

  expect(account.market('earth_station')?.items.size).toBe(1);
  expect(account.marketSubscribed).toBe(true);
});

// --- observation bridges into location ---

function respondToSubscribeObservation(
  socket: MockSocket,
  nearby: SubscribeObservationResponse['nearby'],
  rest: Partial<SubscribeObservationResponse> = {},
): void {
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
            ...rest,
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
    payload: {
      command: 'dock',
      tick: 1,
      result: { location: { poi_id: 'earth_station', docked_at: 'earth_station' } },
    },
  });
  expect(account.state.location?.poi_id).toBe('earth_station');

  const changedSections: string[][] = [];
  account.onStateChange((changed) => changedSections.push([...changed]));

  respondToSubscribeObservation(socket, [{ player_id: 'p1', username: 'Nova', in_combat: false }]);
  await account.subscribeObservation();

  expect(account.state.location?.nearby_players).toEqual([{ player_id: 'p1', username: 'Nova', in_combat: false }]);
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

  expect(account.state.location?.nearby_players).toEqual([{ player_id: 'p2', username: 'Rex', in_combat: true }]);
  expect(account.state.location?.nearby_player_count).toBe(1);
});

test('the observation bridge does not touch location before it has been seeded', async () => {
  const { account, socket } = await connected();
  respondToSubscribeObservation(socket, [{ player_id: 'p1', username: 'Nova', in_combat: false }]);

  await account.subscribeObservation();

  expect(account.state.location).toBeUndefined();
  expect(account.observation()?.nearby.size).toBe(1); // the separate observation cache still has it
});

test('observation() clears once the account leaves the subscribed POI — same silent server-side drop as market subscriptions', async () => {
  const { account, socket } = await connected();
  socket.serverSend({
    type: 'action_result',
    request_id: 'seed',
    payload: {
      command: 'dock',
      tick: 1,
      result: { location: { poi_id: 'earth_station', docked_at: 'earth_station' } },
    },
  });

  respondToSubscribeObservation(socket, [{ player_id: 'p1', username: 'Nova', in_combat: false }]);
  await account.subscribeObservation();
  expect(account.observation()?.nearby.size).toBe(1);
  expect(account.observationSubscribed).toBe(true);

  // Move to a different POI — no observation_update or unsubscribe ack is ever sent for this.
  socket.serverSend({
    type: 'action_result',
    request_id: 'travel-1',
    payload: { command: 'travel', tick: 2, result: { location: { poi_id: 'mars_station', docked_at: null } } },
  });

  expect(account.observation()).toBeNull();
  expect(account.observationSubscribed).toBe(false);
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

test('ObservationCache tracks pirates, empire NPCs, creatures and prizes, not just players', () => {
  const cache = new ObservationCache();
  cache.seed({
    action: 'subscribe_observation',
    active_scan: false,
    unknown_signature: false,
    poi_id: 'earth_station',
    system_id: 'sol',
    nearby: [],
    system_agents: [],
    cloaked_contacts: [],
    pirates: [{ pirate_id: 'k1', name: 'Kael Raider', tier: 'raider', is_boss: false, status: 'hostile', hull: 80 }],
    empire_npcs: [{ npc_id: 'n1', name: 'Patrol Alpha', role: 'patrol', empire: 'solarian', in_combat: false }],
    creatures: [
      {
        creature_id: 'c1',
        species: 'void_grazer',
        name: 'Grazer',
        role: 'passive',
        hull: 40,
        max_hull: 40,
        in_combat: false,
      },
    ],
    prizes: [
      {
        prize_id: 'z1',
        actor_id: 'a1',
        ship_id: 's1',
        ship_class: 'hauler',
        status: 'available',
        hull: 10,
        max_hull: 20,
        shield: 0,
        max_shield: 5,
        in_combat: false,
      },
    ],
  } satisfies SubscribeObservationResponse);
  const seeded = requireValue(cache.current());
  expect(seeded.pirates.get('k1')?.name).toBe('Kael Raider');
  expect(seeded.empireNpcs.get('n1')?.role).toBe('patrol');
  expect(seeded.creatures.get('c1')?.species).toBe('void_grazer');
  expect(seeded.prizes.get('z1')?.ship_class).toBe('hauler');

  cache.applyUpdate({
    poi_id: 'earth_station',
    system_id: 'sol',
    tick: 1701,
    unknown_signature: false,
    pirates_changed: [
      { pirate_id: 'k1', name: 'Kael Raider', tier: 'raider', is_boss: false, status: 'hostile', hull: 30 },
    ],
    empire_npcs_departed: ['n1'],
    creatures_changed: [
      {
        creature_id: 'c2',
        species: 'rift_drifter',
        name: 'Drifter',
        role: 'passive',
        hull: 60,
        max_hull: 60,
        in_combat: true,
      },
    ],
    creatures_departed: ['c1'],
    prizes_departed: ['z1'],
  } satisfies NotificationObservationUpdate);
  const view = requireValue(cache.current());
  expect(view.pirates.get('k1')?.hull).toBe(30); // state change upserts in place
  expect(view.empireNpcs.size).toBe(0);
  expect(view.creatures.has('c1')).toBe(false);
  expect(view.creatures.get('c2')?.species).toBe('rift_drifter');
  expect(view.prizes.size).toBe(0);
});

test('the observation bridge mirrors non-player presence into location too', async () => {
  const { account, socket } = await connected();
  socket.serverSend({
    type: 'action_result',
    request_id: 'seed',
    payload: {
      command: 'dock',
      tick: 1,
      result: { location: { poi_id: 'earth_station', docked_at: 'earth_station' } },
    },
  });

  respondToSubscribeObservation(socket, [], {
    pirates: [
      {
        pirate_id: 'k1',
        name: 'Kael Raider',
        tier: 'raider',
        is_boss: false,
        status: 'hostile',
        hull: 80,
        max_hull: 100,
        shield: 5,
        max_shield: 10,
        primary_color: '#ff0000',
      },
    ],
    empire_npcs: [{ npc_id: 'n1', name: 'Patrol Alpha', role: 'patrol', empire: 'solarian', in_combat: false }],
    prizes: [
      {
        prize_id: 'z1',
        actor_id: 'a1',
        ship_id: 's1',
        ship_class: 'hauler',
        status: 'available',
        hull: 10,
        max_hull: 20,
        shield: 0,
        max_shield: 5,
        in_combat: false,
      },
    ],
    unknown_signature: true,
  });
  await account.subscribeObservation();

  const location = requireValue(account.state.location);
  // livery colors are dropped — `V2NearbyPirate` sets additionalProperties: false
  expect(location.nearby_pirates).toEqual([
    {
      pirate_id: 'k1',
      name: 'Kael Raider',
      tier: 'raider',
      is_boss: false,
      status: 'hostile',
      hull: 80,
      max_hull: 100,
      shield: 5,
      max_shield: 10,
    },
  ]);
  expect(location.nearby_pirate_count).toBe(1);
  expect(location.nearby_empire_npcs?.[0]?.npc_id).toBe('n1');
  expect(location.nearby_empire_npc_count).toBe(1);
  expect(location.nearby_prizes?.[0]?.prize_id).toBe('z1');
  expect(location.nearby_prize_count).toBe(1);
  expect(location.unknown_signature).toBe(true);

  socket.serverSend({
    type: 'observation_update',
    payload: {
      poi_id: 'earth_station',
      system_id: 'sol',
      tick: 5,
      unknown_signature: false,
      pirates_departed: ['k1'],
      prizes_departed: ['z1'],
      empire_npcs_changed: [
        { npc_id: 'n1', name: 'Patrol Alpha', role: 'patrol', empire: 'solarian', in_combat: true },
      ],
      creatures_changed: [
        {
          creature_id: 'c1',
          species: 'void_grazer',
          name: 'Grazer',
          role: 'passive',
          hull: 40,
          max_hull: 40,
          in_combat: false,
        },
      ],
    } satisfies NotificationObservationUpdate,
  });

  const after = requireValue(account.state.location);
  expect(after.nearby_pirates).toEqual([]);
  expect(after.nearby_pirate_count).toBe(0);
  expect(after.nearby_prizes).toEqual([]);
  expect(after.nearby_prize_count).toBe(0);
  expect(after.nearby_empire_npcs?.[0]?.in_combat).toBe(true); // upsert reaches location too
  expect(after.unknown_signature).toBe(false);
  // Wildlife has no location field — it must stay observation-only.
  expect(account.observation()?.creatures.get('c1')?.species).toBe('void_grazer');
  expect(Object.keys(after).some((k) => k.includes('creature'))).toBe(false);
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
