/**
 * Multi-account: persist credentials to a file, connect several bots at once
 * (staggered + auto-reconnecting), and drive them in parallel.
 *
 *   bun run examples/multi-account.ts
 *
 * Uses the Node-only FileCredentialStore from the '/node' entry point.
 */

import { SpacemoltClient } from '../src/index.ts';
import { FileCredentialStore } from '../src/node.ts';

const url = process.env.SPACEMOLT_URL ?? 'wss://game.spacemolt.com/ws/v2';

const client = new SpacemoltClient({
  url,
  store: new FileCredentialStore('./.spacemolt-credentials.json'),
  // reconnect defaults to true; connects are staggered to respect rate limits.
});

// Add accounts once (no-ops if already stored). Replace with real credentials.
await client.addLogin('TraderBot', process.env.TRADER_PASSWORD ?? '');
await client.addLogin('MinerBot', process.env.MINER_PASSWORD ?? '');

// Connect every stored account, staggered.
const accounts = await client.connectAll();
console.log(`connected ${accounts.length} accounts: ${client.ids().join(', ')}`);

// Read a shared reference catalog once (HTTP, cached).
const catalog = await client.catalog();
console.log(`catalog ${catalog.version}: ${catalog.ships.length} ships`);

// Drive each account independently.
await Promise.all(
  client.accounts().map(async (account) => {
    const status = await account.commands.spacemolt.get_status();
    console.log(`${account.player?.username}: ${JSON.stringify(status.structuredContent)}`);
  }),
);

// Keep running to receive pushes; close when done.
// client.closeAll();
