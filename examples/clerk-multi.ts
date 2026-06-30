/**
 * Connect every account you own, authenticated by a Clerk API key.
 *
 *   SPACEMOLT_CLERK_API_KEY=<key> bun run examples/clerk-multi.ts
 *
 * Generate the API key once from the website (see docs/live-testing.md). No
 * per-account passwords are stored — each connection mints its own fresh,
 * single-use WS token from the key, and re-mints on reconnect.
 */

import { SpacemoltClient } from '../src/index.ts';

const apiKey = process.env.SPACEMOLT_CLERK_API_KEY;
if (!apiKey) {
  console.error('set SPACEMOLT_CLERK_API_KEY (generate one from the website)');
  process.exit(1);
}

const client = new SpacemoltClient({
  url: process.env.SPACEMOLT_URL ?? 'wss://game.spacemolt.com/ws/v2',
  clerkApiKey: apiKey,
});

const players = await client.listOwnedPlayers();
console.log(`you own ${players.length} account(s): ${players.map((p) => p.username).join(', ')}`);

// Connect all of them, skipping dashboard-hidden ones. connectOwned staggers the
// connects to respect rate limits, and each account mints its own ws-token.
const selected = players.filter((p) => !p.hidden);
const accounts = await client.connectOwned({ filter: (p) => !p.hidden });
selected.forEach((player, i) => {
  const account = accounts[i];
  console.log(`${player.username}: ${account?.credits ?? '?'} credits, system ${account?.location?.system_id ?? '?'}`);
});

client.closeAll();
