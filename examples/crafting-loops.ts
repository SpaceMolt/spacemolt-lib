/**
 * Crafter loops — the Production layer, plus the two money-making cycles the
 * Crafting Guide describes.
 *
 *   1. `runCraftingMission` — the mission frame over a `craft_item` objective.
 *   2. `runProductionCycle` — buy/withdraw inputs, craft, sell the outputs.
 *
 * Production behaves unlike Extraction or Exchange in three ways that shape
 * every function here:
 *
 *   - **Storage, not cargo.** Inputs are pulled from station storage at the
 *     docked base and outputs land back there. There is no craft-to-cargo path,
 *     so `depositForCraft` / `withdrawOutput` bracket every job.
 *   - **It's a queued job, not an action.** `craft` returns once the job is
 *     *accepted*; the goods arrive over later ticks via `crafting_update`. The
 *     guide is blunt that re-issuing because "nothing happened yet" double-spends
 *     materials — so `craftJob` subscribes *before* queuing and then awaits,
 *     and never polls-and-retries.
 *   - **Venue changes the contract.** A Station Workshop job "advances only
 *     while you're docked here and pauses if you undock"; a facility job "keeps
 *     running after you undock". `craftJob` reports which venue it landed on so
 *     a caller knows whether it may leave.
 */

import type { Account } from '../src/index.ts';
import type { MissionInfo } from '../src/index.ts';
import {
  acceptMission,
  activeMissionId,
  activeMissions,
  board,
  ensureDocked,
  capabilities,
  isActive,
  objectiveProgress,
  objectiveTarget,
  pickMission,
  storedQuantity,
} from './loop-primitives.ts';
import { sellHere } from './trading-loops.ts';

// ---------------------------------------------------------------------------
// Storage movement (Production's I/O)
// ---------------------------------------------------------------------------

/** Move an item from cargo into station storage, where crafting can reach it. */
export async function depositForCraft(account: Account, itemId: string, quantity: number): Promise<void> {
  await account.commands.spacemolt_storage.deposit({ item_id: itemId, quantity });
}

/** Pull a crafted item out of station storage into the cargo hold. */
export async function withdrawOutput(account: Account, itemId: string, quantity: number): Promise<void> {
  await account.commands.spacemolt_storage.withdraw({ item_id: itemId, quantity });
}

// ---------------------------------------------------------------------------
// Quoting and queuing
// ---------------------------------------------------------------------------

export interface CraftQuote {
  recipe: string;
  runs: number;
  /** Credits for labor + any rental fee. Zero at the Station Workshop. */
  credits: number;
  inputs: { itemId: string; quantity: number }[];
  produces: { itemId: string; quantity: number }[];
  venue: string;
  /** Workshop jobs pause when you undock; facility jobs do not. */
  pausesWhenUndocked: boolean;
  haveInputs: boolean;
  haveCredits: boolean;
}

/**
 * Price a job without queuing or spending anything (`dry_run`). This is the
 * cheapest way to discover which venue a recipe will route to and what it truly
 * costs — the auto-routed facility recipe is often dramatically cheaper in
 * materials than the hand-craftable one, so quoting before committing is the
 * difference between a profitable cycle and a wasteful one.
 */
export async function quoteCraft(
  account: Account,
  recipeId: string,
  quantity: number,
): Promise<CraftQuote | undefined> {
  const res = (await account.commands.spacemolt.craft({ id: recipeId, quantity, dry_run: true })).delta?.details;
  if (res?.kind !== 'quote') return undefined;

  return {
    recipe: res.recipe,
    runs: res.runs,
    credits: res.credits_total,
    inputs: (res.cost?.inputs ?? []).flatMap((i) =>
      i.item_id && i.quantity ? [{ itemId: i.item_id, quantity: i.quantity }] : [],
    ),
    produces: (res.produces ?? []).flatMap((p) =>
      p.item_id && p.quantity ? [{ itemId: p.item_id, quantity: p.quantity }] : [],
    ),
    venue: res.venue,
    pausesWhenUndocked: res.venue_type === 'workshop',
    haveInputs: res.have_inputs ?? false,
    haveCredits: res.have_credits ?? false,
  };
}

/**
 * Quote the job that yields exactly `targetRuns` production runs.
 *
 * `craft`'s `quantity` counts **output items**, but a `craft_item` mission
 * objective counts **production runs** — verified live: one run of a recipe
 * yielding 5 units advanced "Craft 5 items" by exactly 1. For a recipe that
 * makes N per run those differ by a factor of N, so asking for `quantity =
 * targetRuns` silently under-delivers. We probe for the per-run yield, then
 * scale the request.
 *
 * Returns the quote plus the `quantity` to pass to `craftJob`.
 */
export async function quoteForRuns(
  account: Account,
  recipeId: string,
  targetRuns: number,
): Promise<{ quote: CraftQuote; quantity: number } | undefined> {
  const probe = await quoteCraft(account, recipeId, targetRuns);
  if (!probe) return undefined;

  const perRun = probe.produces[0]?.quantity ?? 1;
  if (perRun <= 1) return { quote: probe, quantity: targetRuns };

  const quantity = targetRuns * perRun;
  const scaled = await quoteCraft(account, recipeId, quantity);
  return scaled ? { quote: scaled, quantity } : undefined;
}

export interface CraftJobResult {
  reason: 'completed' | 'queued' | 'rejected' | 'timeout' | 'aborted' | 'error';
  jobId?: string;
  recipe?: string;
  runs: number;
  venue?: string;
  pausesWhenUndocked: boolean;
  error?: Error;
}

export interface CraftJobOptions {
  onProgress?: (p: { step: string; detail?: string }) => void;
  signal?: AbortSignal;
  /**
   * Wait for the job to finish. Set false to fire-and-forget a facility job and
   * go do something else — the whole point of an unattended venue.
   */
  await?: boolean;
  /** Give up waiting after this long. Defaults to 5 minutes (~30 ticks). */
  timeoutMs?: number;
}

/**
 * Queue a crafting job and (by default) wait for it to finish.
 *
 * The listener is registered **before** the job is queued: a short job can
 * complete on the very next tick, and subscribing afterwards could miss the
 * notification and hang until the timeout. Waiting is a subscription, never a
 * poll — re-issuing `craft` would queue a second job and double-spend.
 */
export async function craftJob(
  account: Account,
  recipeId: string,
  quantity: number,
  opts: CraftJobOptions = {},
): Promise<CraftJobResult> {
  const shouldAwait = opts.await ?? true;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  try {
    await ensureDocked(account);

    // Subscribe first — see the note above.
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let jobId: string | undefined;
    const unsubscribe = account.on('crafting_update', (update) => {
      const mine = (update.jobs ?? []).filter((j) => !jobId || j.job_id === jobId);
      for (const job of mine) {
        opts.onProgress?.({
          step: 'crafting',
          detail: `${job.recipe} — ${job.runs_done}/${job.runs_done + job.runs_remaining} run(s)`,
        });
        if (job.completed) resolveDone?.();
      }
    });

    try {
      opts.onProgress?.({ step: 'queuing', detail: `${quantity} x ${recipeId}` });
      const res = (await account.commands.spacemolt.craft({ id: recipeId, quantity })).delta?.details;

      if (res?.kind !== 'job') {
        return { reason: 'rejected', runs: 0, pausesWhenUndocked: false };
      }

      jobId = res.job_id;
      const base = {
        jobId: res.job_id,
        recipe: res.recipe,
        runs: res.runs,
        venue: res.venue,
        pausesWhenUndocked: res.venue_type === 'workshop',
      };
      if (!shouldAwait) return { reason: 'queued', ...base };

      opts.onProgress?.({ step: 'waiting', detail: `${res.runs} run(s) at ${res.venue}` });
      const outcome = await Promise.race([
        done.then(() => 'completed' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
        abortSignal(opts.signal),
      ]);

      return { reason: outcome, ...base };
    } finally {
      unsubscribe();
    }
  } catch (error) {
    return {
      reason: 'error',
      runs: 0,
      pausesWhenUndocked: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/** Resolves 'aborted' if the signal fires; never resolves otherwise. */
function abortSignal(signal?: AbortSignal): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) return resolve('aborted');
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

// ---------------------------------------------------------------------------
// Selectors (pure)
// ---------------------------------------------------------------------------

/** Missions satisfied by crafting. */
export function isCraftingMission(m: MissionInfo): boolean {
  return (m.objectives ?? []).some((o) => o.type === 'craft_item');
}

export interface RecipeOption {
  recipeId: string;
  /** Input units consumed per output item — lower is better. */
  inputsPerOutput: number;
}

/**
 * Cheapest recipe by input consumed per item produced.
 *
 * Recipes that make the same good can differ several-fold in material cost, and
 * a `craft_item` mission only counts *items produced* — so when the goal is a
 * count, the efficient recipe is strictly better.
 */
export function cheapestRecipe(options: readonly RecipeOption[]): RecipeOption | undefined {
  return [...options].sort((a, b) => a.inputsPerOutput - b.inputsPerOutput)[0];
}

// ---------------------------------------------------------------------------
// Loop 1 — the mission frame
// ---------------------------------------------------------------------------

export type CraftingStopReason = 'completed' | 'no-mission' | 'unsatisfiable' | 'wrong-venue' | 'aborted' | 'error';

export interface CraftingMissionResult {
  reason: CraftingStopReason;
  missionId?: string;
  title?: string;
  credits: number;
  crafted: number;
  error?: Error;
}

/**
 * Accept the best crafting mission on the local board and satisfy it with
 * `recipeId`.
 *
 * The recipe is a parameter rather than inferred: `craft_item` objectives are
 * written loosely ("craft 5 items using any recipe"), so the caller — who knows
 * what's in storage and what sells — chooses. `cheapestRecipe` helps rank them.
 *
 * **Venue matters, and the objective text doesn't say so.** Observed live:
 * "Workshop Production Run" ("Craft 5 items using any recipe") stayed at 0/5
 * after six items were crafted at a *rented facility* — the mission counts only
 * Station Workshop output, as its description ("at a station crafting
 * workshop") implies. Since `craft` auto-routes to a facility whenever one can
 * run the recipe, a loop that ignores this happily spends the materials and
 * earns nothing. So we quote first and refuse a non-workshop venue by default;
 * pass `requireWorkshop: false` for missions that genuinely don't care.
 *
 * Resumes rather than double-accepting if the mission is already on our list.
 */
export async function runCraftingMission(
  account: Account,
  recipeId: string,
  opts: {
    onProgress?: (p: { step: string; detail?: string }) => void;
    signal?: AbortSignal;
    requireWorkshop?: boolean;
  } = {},
): Promise<CraftingMissionResult> {
  const finish = (reason: CraftingStopReason, extra: Partial<CraftingMissionResult> = {}): CraftingMissionResult => ({
    reason,
    credits: 0,
    crafted: 0,
    ...extra,
  });

  const requireWorkshop = opts.requireWorkshop ?? true;

  try {
    await ensureDocked(account);
    opts.onProgress?.({ step: 'reading-board' });

    // An already-accepted mission is no longer on the board, so check our own
    // list first and resume it instead of looking for a fresh one.
    const resumable = activeMissions(account).find(
      (m) => (m.objectives ?? []).some((o) => o.type === 'craft_item') && !m.objectives?.every((o) => o.completed),
    );
    const mission = resumable ?? pickMission(await board(account), isCraftingMission, capabilities(account))?.mission;
    if (!mission) return finish('no-mission');

    const objective = (mission.objectives ?? []).find((o) => o.type === 'craft_item');
    if (!objective) return finish('unsatisfiable', { title: mission.title });

    // The objective counts production runs, and a resumed mission has already
    // banked some — craft only the shortfall.
    const remainingRuns = objectiveTarget(objective) - objectiveProgress(objective);
    if (remainingRuns <= 0) return finish('unsatisfiable', { title: mission.title });

    // Quote before committing: catches "can't afford the inputs" and the venue
    // trap below, before a mission slot or any materials are spent.
    const plan = await quoteForRuns(account, recipeId, remainingRuns);
    if (!plan?.quote.haveInputs || !plan.quote.haveCredits) {
      return finish('unsatisfiable', { title: mission.title });
    }
    const { quote, quantity } = plan;
    if (requireWorkshop && !quote.pausesWhenUndocked) {
      opts.onProgress?.({ step: 'wrong-venue', detail: `${recipeId} routes to ${quote.venue}` });
      return finish('wrong-venue', { title: mission.title });
    }
    opts.onProgress?.({ step: 'planned', detail: `${remainingRuns} run(s) => quantity ${quantity}` });

    if (!isActive(account, mission)) {
      opts.onProgress?.({ step: 'accepting', detail: mission.title });
      await acceptMission(account, mission);
    } else {
      opts.onProgress?.({ step: 'resuming', detail: mission.title });
    }

    // Resolve the *instance* id only after accepting — it doesn't exist before.
    const missionId = activeMissionId(account, mission);
    if (!missionId) return finish('unsatisfiable', { title: mission.title });

    const job = await craftJob(account, recipeId, quantity, opts);
    if (job.reason === 'aborted') return finish('aborted', { missionId, title: mission.title });
    if (job.reason !== 'completed') {
      return finish(job.reason === 'error' ? 'error' : 'unsatisfiable', {
        missionId,
        title: mission.title,
        error: job.error,
      });
    }

    opts.onProgress?.({ step: 'completing', detail: mission.title });
    await account.commands.spacemolt.complete_mission({ id: missionId });

    return {
      reason: 'completed',
      missionId,
      title: mission.title,
      credits: mission.rewards?.credits ?? 0,
      crafted: remainingRuns,
    };
  } catch (error) {
    return finish('error', { error: error instanceof Error ? error : new Error(String(error)) });
  }
}

// ---------------------------------------------------------------------------
// Loop 2 — production for margin
// ---------------------------------------------------------------------------

export interface ProductionResult {
  reason: 'sold' | 'crafted' | 'no-inputs' | 'rejected' | 'aborted' | 'error';
  recipe?: string;
  produced: number;
  earned: number;
  /** Net of the job's credit cost; excludes the input materials' opportunity cost. */
  profit: number;
  error?: Error;
}

/**
 * Craft from station storage and sell the output on the local exchange.
 *
 * Quotes first so the caller never queues a job it can't cover, then withdraws
 * the finished goods to cargo and sells. Refined goods are typically worth many
 * times their ore, which is what makes this worth the ticks.
 */
export async function runProductionCycle(
  account: Account,
  recipeId: string,
  quantity: number,
  opts: { onProgress?: (p: { step: string; detail?: string }) => void; signal?: AbortSignal; sell?: boolean } = {},
): Promise<ProductionResult> {
  const empty: ProductionResult = { reason: 'no-inputs', produced: 0, earned: 0, profit: 0 };
  try {
    await ensureDocked(account);

    const quote = await quoteCraft(account, recipeId, quantity);
    if (!quote) return { ...empty, reason: 'rejected' };
    if (!quote.haveInputs || !quote.haveCredits) return empty;
    opts.onProgress?.({ step: 'quoted', detail: `${quote.runs} run(s) at ${quote.venue}, ${quote.credits}cr` });

    const output = quote.produces[0];

    // Measure the stock *before* crafting. Storage is shared with everything
    // else you've banked, so the post-craft total is not this job's output —
    // and the difference is not cosmetic: selling the total would liquidate a
    // stockpile the caller deliberately kept. Caught live crafting 4 steel
    // plates onto 13 banked ones and reporting 17.
    const before = output ? await storedQuantity(account, output.itemId) : 0;

    const job = await craftJob(account, recipeId, quantity, opts);
    if (job.reason === 'aborted') return { ...empty, reason: 'aborted' };
    if (job.reason !== 'completed') {
      return { ...empty, reason: job.reason === 'error' ? 'error' : 'rejected', error: job.error };
    }

    if (!output) return { ...empty, reason: 'crafted', recipe: quote.recipe };

    // Measure rather than trust the quote — a run can yield extras — but only
    // ever count and sell what this job added.
    const after = await storedQuantity(account, output.itemId);
    const produced = Math.max(0, after - before);
    if (produced <= 0 || opts.sell === false) {
      return { reason: 'crafted', recipe: quote.recipe, produced, earned: 0, profit: -quote.credits };
    }

    opts.onProgress?.({ step: 'withdrawing', detail: `${produced} x ${output.itemId}` });
    await withdrawOutput(account, output.itemId, produced);

    opts.onProgress?.({ step: 'selling', detail: `${produced} x ${output.itemId}` });
    const sold = await sellHere(account, output.itemId, produced);

    return {
      reason: 'sold',
      recipe: quote.recipe,
      produced,
      earned: sold.credits,
      profit: sold.credits - quote.credits,
    };
  } catch (error) {
    return { ...empty, reason: 'error', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { Account } = await import('../src/index.ts');
  const username = process.env.SPACEMOLT_USERNAME;
  const password = process.env.SPACEMOLT_PASSWORD;
  if (!username || !password) {
    console.error('set SPACEMOLT_USERNAME and SPACEMOLT_PASSWORD (see docs/live-testing.md)');
    process.exit(1);
  }

  const recipeId = process.argv[2] ?? 'refine_steel';
  const quantity = Number(process.argv[3] ?? 5);

  const account = new Account({ url: process.env.SPACEMOLT_URL });
  await account.connect();
  await account.login({ username, password });

  const result = await runProductionCycle(account, recipeId, quantity, {
    onProgress: (p) => console.log(`  ${p.step}${p.detail ? `: ${p.detail}` : ''}`),
  });

  console.log(
    result.reason === 'sold'
      ? `sold ${result.produced} for ${result.earned}cr (net ${result.profit >= 0 ? '+' : ''}${result.profit}cr)`
      : `stopped: ${result.reason}${result.error ? ` — ${result.error.message}` : ''}`,
  );
  account.close();
}
