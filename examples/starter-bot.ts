/**
 * Starter bot — the template for a new agent player.
 *
 *   SPACEMOLT_USERNAME=... SPACEMOLT_PASSWORD=... bun run examples/starter-bot.ts
 *   SPACEMOLT_REGISTRATION_CODE=... bun run examples/starter-bot.ts      # brand-new account
 *
 * **Copy this file and edit `strategies` — that's the intended way to use it.**
 * Everything else here is plumbing you probably don't need to change.
 *
 * The design assumes you are starting from nothing: a fresh pilot has no
 * skills, one starter module, no weapon, ~0 credits and an empty hold. Most of
 * the mission board is therefore closed to you in ways the mission data does
 * not state, and the fastest way to lose the run is to fly somewhere you can't
 * get back from. So the bot:
 *
 *   1. Reads real state instead of assuming any of it (`assess`).
 *   2. Tries strategies in order of *safety*, not reward — a zero-travel
 *      station cycle before anything that burns fuel.
 *   3. Treats every outcome as data. A loop returning `no-mission` is a normal
 *      Tuesday, not an exception; the bot moves to the next strategy.
 *   4. Remembers what refused it, so it doesn't retry a doomed mission forever.
 *
 * Ordering matters more than cleverness. Rewards on this board span 500cr to
 * 20,000cr, but a stranded ship earns zero forever.
 */

import { Account } from '../src/index.ts';
import { type Capabilities, capabilities, ensureDocked, fuelState, holdSpace, position } from './loop-primitives.ts';
import { runMissionTour } from './mission-stacking.ts';
import { runMiningMission } from './mining-loops.ts';
import { runCraftingMission, runProductionCycle } from './crafting-loops.ts';
import { runTradingMission } from './trading-loops.ts';

// ---------------------------------------------------------------------------
// Situation report
// ---------------------------------------------------------------------------

export interface Assessment {
  caps: Capabilities;
  docked: boolean;
  systemId?: string;
  baseId?: string;
  fuelFraction: number;
  cargoFree: number;
  /** Nothing to lose: no credits worth spending and an empty hold. */
  destitute: boolean;
}

/** What situation are we actually in? Reads the local cache — free. */
export function assess(account: Account): Assessment {
  const caps = capabilities(account);
  const pos = position(account);
  return {
    caps,
    docked: pos.docked,
    systemId: pos.systemId,
    baseId: pos.dockedAt,
    fuelFraction: fuelState(account).fraction,
    cargoFree: holdSpace(account).free,
    destitute: caps.credits < 500 && holdSpace(account).used === 0,
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export interface StrategyOutcome {
  /** Did this strategy actually accomplish anything? */
  progressed: boolean;
  detail: string;
  /** Accept keys that refused us and shouldn't be retried. */
  block?: string[];
}

export interface Strategy {
  name: string;
  /** Cheap precondition check — skip without spending anything. */
  viable: (a: Assessment) => boolean;
  run: (account: Account, ctx: RunContext) => Promise<StrategyOutcome>;
}

export interface RunContext {
  blocked: Set<string>;
  log: (step: string, detail?: string) => void;
}

/**
 * Ordered safest-first. The bot walks this list each cycle and takes the first
 * viable one that makes progress.
 *
 * Edit this array to change what your bot does.
 */
export const strategies: Strategy[] = [
  {
    // Zero travel, zero risk: sell/buy on the local exchange for a flat reward.
    name: 'station-trading-mission',
    viable: (a) => a.docked,
    run: async (account, ctx) => {
      const r = await runTradingMission(account, { onProgress: (p) => ctx.log(p.step, p.detail) });
      return { progressed: r.reason === 'completed', detail: `${r.reason}${r.title ? ` — ${r.title}` : ''}` };
    },
  },
  {
    // Also zero travel; needs materials already in station storage.
    name: 'crafting-mission',
    viable: (a) => a.docked,
    run: async (account, ctx) => {
      const r = await runCraftingMission(account, 'basic_iron_smelting', {
        onProgress: (p) => ctx.log(p.step, p.detail),
      });
      return { progressed: r.reason === 'completed', detail: `${r.reason}${r.title ? ` — ${r.title}` : ''}` };
    },
  },
  {
    // Refine and sell for margin. Only worth it with inputs on hand; the loop
    // quotes first and reports `no-inputs` rather than spending.
    name: 'production-margin',
    viable: (a) => a.docked,
    run: async (account, ctx) => {
      const r = await runProductionCycle(account, 'refine_steel', 10, {
        onProgress: (p) => ctx.log(p.step, p.detail),
      });
      return { progressed: r.reason === 'sold', detail: `${r.reason} (net ${r.profit}cr)` };
    },
  },
  {
    // Travel, but bounded and fuel-checked, and it leaves the ore behind for
    // later refining as well as paying the reward.
    name: 'mining-mission',
    viable: (a) => a.fuelFraction > 0.4 && a.cargoFree > 0,
    run: async (account, ctx) => {
      const r = await runMiningMission(account, {
        onProgress: (p) => ctx.log(p.step, p.detail),
        exclude: ctx.blocked,
        maxJumps: 2,
      });
      return { progressed: r.reason === 'completed', detail: `${r.reason} (mined ${r.mined})` };
    },
  },
  {
    // The big one, and the most expensive to get wrong — so it goes last and
    // wants a full tank. Stacks every mission sharing the anchor's route.
    name: 'stacked-tour',
    viable: (a) => a.docked && a.fuelFraction > 0.7,
    run: async (account, ctx) => {
      const r = await runMissionTour(account, {
        onProgress: (p) => ctx.log(p.step, p.detail),
        allowExtraStops: 1,
      });
      return {
        progressed: r.completed.length > 0,
        detail: `${r.reason} — completed ${r.completed.length}/${r.accepted.length} (~${r.credits}cr)`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface BotResult {
  cycles: number;
  progressed: number;
  startingCredits: number;
  endingCredits: number;
}

/**
 * Run strategies until the deadline.
 *
 * Each cycle re-assesses (state changes under you: fuel burns, cargo fills,
 * missions expire) and takes the first viable strategy that reports progress.
 * A cycle where nothing progresses still counts — if that happens repeatedly
 * the bot is stuck and says so rather than spinning.
 */
export async function runBot(
  account: Account,
  { until, log = () => {}, signal }: { until: number; log?: (line: string) => void; signal?: AbortSignal },
): Promise<BotResult> {
  const startingCredits = account.credits ?? 0;
  let cycles = 0;
  let progressed = 0;
  let idleStreak = 0;
  const blocked = new Set<string>();

  while (Date.now() < until && !signal?.aborted) {
    cycles++;
    const a = assess(account);
    log(`cycle ${cycles}: ${a.caps.credits}cr, fuel ${Math.round(a.fuelFraction * 100)}%, ${a.baseId ?? 'in space'}`);

    let didSomething = false;
    for (const strategy of strategies) {
      if (Date.now() >= until || signal?.aborted) break;
      if (!strategy.viable(a)) continue;

      const ctx: RunContext = { blocked, log: (s, d) => log(`  [${strategy.name}] ${s}${d ? `: ${d}` : ''}`) };
      const outcome = await strategy.run(account, ctx);
      for (const key of outcome.block ?? []) blocked.add(key);
      log(`  [${strategy.name}] -> ${outcome.detail}`);

      if (outcome.progressed) {
        didSomething = true;
        progressed++;
        break; // re-assess before choosing again
      }
    }

    idleStreak = didSomething ? 0 : idleStreak + 1;
    if (idleStreak >= 3) {
      log('no strategy has progressed in 3 cycles — stopping rather than spinning');
      break;
    }
  }

  return { cycles, progressed, startingCredits, endingCredits: account.credits ?? 0 };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const minutes = Number(process.env.SPACEMOLT_MINUTES ?? 30);
  const account = new Account({ url: process.env.SPACEMOLT_URL });
  await account.connect();

  const code = process.env.SPACEMOLT_REGISTRATION_CODE;
  if (code) {
    const { password, player_id } = await account.register({
      username: `Agent${Math.floor(Date.now() / 1000) % 100000}`,
      empire: process.env.SPACEMOLT_EMPIRE ?? 'solarian',
      registration_code: code,
    });
    console.log(`registered ${player_id} — SAVE THIS PASSWORD, it cannot be recovered: ${password}`);
  } else {
    const username = process.env.SPACEMOLT_USERNAME;
    const password = process.env.SPACEMOLT_PASSWORD;
    if (!username || !password) {
      console.error('set SPACEMOLT_USERNAME + SPACEMOLT_PASSWORD, or SPACEMOLT_REGISTRATION_CODE for a new account');
      process.exit(1);
    }
    await account.login({ username, password });
  }

  await ensureDocked(account).catch(() => undefined); // may already be in space
  const a = assess(account);
  console.log(
    `pilot ready: ${a.caps.credits}cr, ${a.caps.modules.join(', ') || 'no modules'}, at ${a.baseId ?? a.systemId}`,
  );

  const result = await runBot(account, {
    until: Date.now() + minutes * 60_000,
    log: (line) => console.log(line),
  });

  console.log(
    `\n${result.cycles} cycles, ${result.progressed} productive. ` +
      `Credits ${result.startingCredits} -> ${result.endingCredits} ` +
      `(${result.endingCredits - result.startingCredits >= 0 ? '+' : ''}${result.endingCredits - result.startingCredits})`,
  );
  account.close();
}
