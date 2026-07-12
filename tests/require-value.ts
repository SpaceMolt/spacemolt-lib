/** Return a test fixture value or fail immediately with a useful setup error. */
export function requireValue<T>(value: T | null | undefined, message = 'expected test value to exist'): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
