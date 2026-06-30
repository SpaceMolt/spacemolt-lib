/**
 * Live smoke test — drives the full pipeline against a real server and reports
 * PASS/FAIL per stage, so a failure tells you exactly how far you got instead of
 * throwing a stack trace. The normal test suite uses a mock socket; this is the
 * one that proves the library works against an actual server.
 *
 * Auth (pick one):
 *   - Register a fresh account. Needs a registration_code, which on production is
 *     minted by the Clerk-authenticated GET /api/registration-code — see
 *     docs/live-testing.md:
 *       SPACEMOLT_REGISTRATION_CODE=<code> bun run examples/smoke.ts
 *       # or pass the code as the first argument:
 *       bun run examples/smoke.ts <code>
 *   - Log in to an existing account:
 *       SPACEMOLT_USERNAME=<name> SPACEMOLT_PASSWORD=<pw> bun run examples/smoke.ts
 *
 * Override the server with SPACEMOLT_URL (default wss://game.spacemolt.com/ws/v2).
 * On register the generated password is printed once — SAVE IT.
 */

import { Account, SpacemoltError } from '../src/index.ts';

const url = process.env.SPACEMOLT_URL ?? 'wss://game.spacemolt.com/ws/v2';
const registrationCode = process.argv[2] ?? process.env.SPACEMOLT_REGISTRATION_CODE;
const username = process.env.SPACEMOLT_USERNAME;
const password = process.env.SPACEMOLT_PASSWORD;
const empire = process.env.SPACEMOLT_EMPIRE ?? 'solarian';

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await fn();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    passed++;
    return true;
  } catch (err) {
    const msg = err instanceof SpacemoltError ? `${err.code}: ${err.message}` : String(err);
    console.log(`  FAIL  ${name} — ${msg}`);
    failed++;
    return false;
  }
}

const account = new Account({ url });

// Record every unsolicited server push frame we see during the run.
const pushes: string[] = [];
account.onAny((frame) => {
  pushes.push(frame.type);
});

console.log(`\nSpaceMolt live smoke — ${url}\n`);

const connected = await step('connect + welcome', async () => {
  await account.connect();
  if (!account.welcome) throw new Error('no welcome frame received');
  return `server v${account.welcome.version}`;
});

if (connected) {
  const authed = await step('authenticate', async () => {
    if (registrationCode !== undefined) {
      const { password: pw, player_id } = await account.register({
        username: `Smoke${Math.floor(Date.now() / 1000) % 100000}`,
        empire,
        registration_code: registrationCode,
      });
      console.log(`        registered ${player_id} — SAVE THIS PASSWORD: ${pw}`);
      return 'registered new account';
    }
    if (username && password) {
      await account.login({ username, password });
      return `logged in as ${username}`;
    }
    throw new Error(
      'no credentials: set SPACEMOLT_REGISTRATION_CODE (or pass it as arg 1), or SPACEMOLT_USERNAME + SPACEMOLT_PASSWORD',
    );
  });

  if (authed) {
    await step('state cache seeded (get_status)', async () => {
      if (typeof account.credits !== 'number') throw new Error('credits not seeded from get_status');
      return `credits=${account.credits}, system=${account.location?.system_id ?? '?'}`;
    });

    await step('query round-trip (get_status)', async () => {
      const res = await account.query('spacemolt', 'get_status');
      if (!res.structuredContent) throw new Error('no structuredContent in response');
      return 'structuredContent received';
    });

    await step('query round-trip (get_skills)', async () => {
      const res = await account.query('spacemolt', 'get_skills');
      if (!res.structuredContent) throw new Error('no structuredContent in response');
      return 'structuredContent received';
    });

    await step('two-phase mutation (scan)', async () => {
      try {
        const res = await account.send('spacemolt', 'scan');
        return 'tick' in res ? `executed on tick ${res.tick}` : 'resolved';
      } catch (err) {
        // A game-level rejection still proves the pending -> action_result
        // transport works end to end; only a transport failure is a real FAIL.
        if (err instanceof SpacemoltError) return `transport OK (server rejected: ${err.code})`;
        throw err;
      }
    });

    await step('push notifications', async () => {
      // Give the server a moment to deliver any unsolicited frames.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return pushes.length
        ? `${pushes.length} frame(s): ${[...new Set(pushes)].join(', ')}`
        : 'none in 3s (fine — depends on world activity)';
    });
  }
}

await step('clean close', async () => {
  account.close();
});

console.log(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed > 0 ? 1 : 0);
