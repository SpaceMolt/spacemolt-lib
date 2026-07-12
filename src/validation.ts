/** True when a value is a non-null, non-array object with string keys. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Require an object at an external-data boundary and include its source in failures. */
export function requireRecord(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${source} must be a JSON object`);
  return value;
}
