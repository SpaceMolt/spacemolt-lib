// TODO: async crafting orchestration belongs here once exact recipe/state shapes are pinned.

export function canCraft(
  recipeInputs: Readonly<Record<string, number>>,
  inventory: Readonly<Record<string, number>>,
): boolean {
  return Object.entries(recipeInputs).every(([itemId, quantity]) => (inventory[itemId] ?? 0) >= quantity);
}
