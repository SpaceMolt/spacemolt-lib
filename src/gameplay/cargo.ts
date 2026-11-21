export interface CargoTotals {
  used: number;
  capacity: number;
  free: number;
}

export function cargoTotals(
  ship: { cargo_used?: number | null; cargo_capacity?: number | null } | null | undefined,
): CargoTotals {
  const used = ship?.cargo_used ?? 0;
  const capacity = ship?.cargo_capacity ?? 0;
  return { used, capacity, free: Math.max(0, capacity - used) };
}

export function itemQuantity(
  cargo: readonly { item_id?: string; quantity?: number }[] | null | undefined,
  itemId: string,
): number {
  return cargo?.find((c) => c.item_id === itemId)?.quantity ?? 0;
}

export function hasCargo(
  cargo: readonly { item_id?: string; quantity?: number }[] | null | undefined,
  itemId: string,
  quantity: number,
): boolean {
  return itemQuantity(cargo, itemId) >= quantity;
}
