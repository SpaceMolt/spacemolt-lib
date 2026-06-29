/**
 * Quickstart: register (or log in), read live state, and mine once.
 *
 *   bun run examples/quickstart.ts <registration_code>
 *
 * Set SPACEMOLT_URL to point at a different server. Credentials are kept in
 * memory here — use a CredentialStore (see multi-account.ts) to persist them.
 */

import { Account } from '../src/index.ts';

const url = process.env.SPACEMOLT_URL ?? 'wss://game.spacemolt.com/ws/v2';
const registrationCode = process.argv[2];

const account = new Account({ url });
await account.connect();
console.log(`connected to SpaceMolt ${account.welcome?.version}`);

if (registrationCode) {
  const { password, player_id } = await account.register({
    username: `Demo${Math.floor(Date.now() / 1000) % 100000}`,
    empire: 'solarian',
    registration_code: registrationCode,
  });
  console.log(`registered ${player_id}. SAVE THIS PASSWORD: ${password}`);
} else {
  // Replace with real credentials to log in instead of register.
  await account.login({ username: 'YourName', password: process.env.SPACEMOLT_PASSWORD ?? '' });
}

// State is cached locally, seeded from get_status after auth.
console.log(`credits: ${account.credits}, system: ${account.location?.system_id}`);

// React to live events while we act.
account.on('mining_yield', (y) => console.log(`mined ${y.quantity} x ${y.resource_id}`));

// Mutations resolve when they execute on a later tick; the state cache is
// already updated by the time this returns.
const result = await account.commands.spacemolt.mine();
console.log(`mined on tick ${result.tick}; cargo now:`, account.cargo);

account.close();
