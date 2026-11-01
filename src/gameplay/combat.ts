export function hullPercent(hull: number | null | undefined, maxHull: number | null | undefined): number {
  if (!maxHull || maxHull <= 0) return 0;
  return Math.max(0, Math.min(1, (hull ?? 0) / maxHull));
}

export function shouldFlee(
  hull: number | null | undefined,
  maxHull: number | null | undefined,
  threshold = 0.2,
): boolean {
  return hullPercent(hull, maxHull) < threshold;
}
