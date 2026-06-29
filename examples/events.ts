/**
 * Live events + subscriptions: stream chat, watch a market, react to combat.
 *
 *   bun run examples/events.ts
 *
 * Assumes you have stored login credentials (see multi-account.ts) or adapt to
 * use account.login(...) directly.
 */

import { Account } from '../src/index.ts';

const url = process.env.SPACEMOLT_URL ?? 'wss://game.spacemolt.com/ws/v2';
const account = new Account({ url });
await account.connect();
await account.login({ username: 'YourName', password: process.env.SPACEMOLT_PASSWORD ?? '' });

// Callback style: typed payloads for published notification types.
account.on('chat_message', (msg) => console.log(`[${msg.channel}] ${msg.sender}: ${msg.content}`));
account.on('player_died', (d) => console.log(`you died — respawning at ${d.respawn_base}`));

// React to which state sections changed on each mutation/push.
account.onStateChange((sections) => console.log('state changed:', sections.join(', ')));

// Subscribe to the market of the station you're docked at; updates merge into
// the local cache automatically.
if (account.location?.docked_at) {
  const baseline = await account.subscribeMarket();
  console.log(`watching market at ${baseline.base_name} (${baseline.items?.length} items)`);
  account.on('market_update', (u) => {
    const book = account.market(u.base_id);
    console.log(`market tick ${u.tick}: ${book?.items.size} items cached`);
  });
}

// Async-iterator style: process battle damage as it streams in. `break` to stop.
(async () => {
  for await (const hit of account.events('battle_damage')) {
    console.log(`battle: ${hit.attacker_name} hit ${hit.target_name} for ${hit.total_damage}`);
  }
})();

// Lifecycle hooks.
account.onReconnecting((attempt) => console.log(`reconnecting (attempt ${attempt})…`));
account.onReconnected(() => console.log('reconnected'));
account.onDisconnected((err) => console.log(`disconnected for good: ${err.message}`));
