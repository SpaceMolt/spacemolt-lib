export function needsRepair(
  hull: number | null | undefined,
  maxHull: number | null | undefined,
  threshold = 0.9,
): boolean {
  if (!maxHull || maxHull <= 0) return false;
  return (hull ?? 0) / maxHull < threshold;
}
