import type { Account } from '../account.ts';

export interface FuelGatePlan {
  estimated_fuel?: number;
  fuel_available?: number;
}

export function estimateFuelOk(plan: FuelGatePlan | null | undefined): boolean {
  return (plan?.fuel_available ?? 0) >= (plan?.estimated_fuel ?? 0);
}

export interface JumpResult {
  arrivedAt: string;
  hops: number;
}
export interface JumpOptions {
  onArrive?: (hop: { systemId: string; name: string; remaining: number }) => void;
  signal?: AbortSignal;
}

export async function jumpToSystem(
  account: Account,
  targetSystemId: string,
  opts: JumpOptions = {},
): Promise<JumpResult> {
  if (account.location?.system_id === targetSystemId) return { arrivedAt: targetSystemId, hops: 0 };
  if (account.location?.docked_at) await account.commands.spacemolt.undock();

  const plan = (await account.commands.spacemolt.find_route({ id: targetSystemId })).structuredContent as
    | {
        found?: boolean;
        message?: string;
        estimated_fuel?: number;
        fuel_available?: number;
        route?: { system_id: string; name: string }[];
      }
    | undefined;

  if (!plan?.found) throw new Error(`no route to ${targetSystemId}: ${plan?.message ?? 'unknown'}`);
  if (!estimateFuelOk(plan)) {
    throw new Error(`route needs ${plan.estimated_fuel} fuel, have ${plan.fuel_available}`);
  }

  let hops = 0;
  const total = (plan.route ?? []).filter((h) => h.system_id !== account.location?.system_id).length;
  for (const hop of plan.route ?? []) {
    if (hop.system_id === account.location?.system_id) continue;
    if (opts.signal?.aborted) break;
    await account.commands.spacemolt.jump({ id: hop.system_id });
    hops++;
    opts.onArrive?.({ systemId: hop.system_id, name: hop.name, remaining: total - hops });
  }
  return { arrivedAt: account.location?.system_id ?? targetSystemId, hops };
}
