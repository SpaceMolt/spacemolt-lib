/**
 * Adds random jitter to a retry delay, so multiple callers retrying together
 * (e.g. a fleet of accounts sharing a per-IP rate limit) don't all wake up
 * and retry in the same instant. Extra is uniform in `[0, max(25% of base,
 * 250ms))`. Shared by the WebSocket rate-limit retry (`account.ts`) and the
 * HTTP retry (`data/http.ts`).
 */
export function jitteredDelayMs(baseMs: number): number {
  return baseMs + Math.random() * Math.max(baseMs * 0.25, 250);
}
