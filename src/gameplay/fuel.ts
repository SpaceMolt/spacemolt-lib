export function needsRefuel(current: number, capacity: number, threshold = 0.25): boolean {
  if (capacity <= 0) return false;
  return current / capacity < threshold;
}
