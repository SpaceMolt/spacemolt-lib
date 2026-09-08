/**
 * Pure inventory selectors — no `Account`, no I/O. Cargo (`account.cargo`)
 * and station/faction storage (`spacemolt_storage.view()`) both come back as
 * lists of `{ item_id, quantity }` (the generated `CargoItem` shape), so one
 * merge covers both without an adapter.
 */

export interface InventoryLine {
  item_id: string;
  quantity: number;
}

/** Sum quantities for the same item_id across any number of cargo/storage lists. */
export function mergeInventory(...lists: readonly (readonly InventoryLine[])[]): Map<string, number> {
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
