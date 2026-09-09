/**
 * Pure inventory selectors — no `Account`, no I/O. Cargo (`account.cargo`)
 * and station/faction storage (`spacemolt_storage.view()`) both come back as
 * lists of the generated `CargoItem`, so one merge covers both without an
 * adapter.
 */

import type { CargoItem } from '../generated/openapi/types.gen.ts';

/** Sum quantities for the same item_id across any number of cargo/storage lists. */
export function mergeInventory(...lists: readonly (readonly CargoItem[])[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const list of lists) {
    for (const line of list) {
      totals.set(line.item_id, (totals.get(line.item_id) ?? 0) + line.quantity);
    }
  }
  return totals;
}

/** How many of `itemId` a merged inventory holds (0 when absent). */
export function heldQuantity(inventory: ReadonlyMap<string, number>, itemId: string): number {
  return inventory.get(itemId) ?? 0;
}
