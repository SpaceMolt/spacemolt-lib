import { HttpError } from '../errors.ts';
import { jitteredDelayMs } from '../jitter.ts';

/**
 * Shared HTTP GET for the library's bulk/live data fetches (catalog, map,
 * stations, mobile-base). Bounds every request — including reading the
 * response body, not just its headers — with a timeout, retries a transient
 * `429`/`503` a few times (honoring `Retry-After` when the server sends one,
 * jittered the same way as the WebSocket side's rate-limit retry — see
 * `jitteredDelayMs`), and reports a retry-exhausted or otherwise non-ok
 * response as a typed `HttpError`. A timeout or network error is not an
 * `HttpError` — it throws the native `DOMException`/`TypeError` as-is.
 * `MAX_RETRY_WAIT_MS` caps the *total* base wait across every attempt, not
 * each attempt checked in isolation.
 */

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_WAIT_MS = 60_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parses `Retry-After` as delta-seconds or an HTTP-date. Returns ms to wait, or undefined if unparseable. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

export interface HttpGetOptions {
  headers?: Record<string, string>;
  /** Abort the request after this many ms (`AbortSignal.timeout`). Default 30000. */
  timeoutMs?: number;
  /**
   * Inject a `fetch` implementation — tests, custom runtimes, or an
   * observability wrapper (status/bytes/timing/retries) a consumer supplies
   * via `SpacemoltClientOptions.fetchImpl` / the per-call `fetchImpl` option.
   * Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Response statuses besides 2xx to return rather than treat as a failure (e.g. 304). */
  okStatuses?: readonly number[];
  /**
   * Total (un-jittered) base retry wait allowed across every attempt before
   * giving up — not re-checked per attempt in isolation. Default
   * `MAX_RETRY_WAIT_MS` (60000). Mainly for tests that need a small cap to
   * exercise this without waiting real seconds.
   */
  maxRetryWaitMs?: number;
}

/**
 * `GET url`, bounded by `timeoutMs` (headers and body both) and retried up to
 * `MAX_RETRIES` times on `429`/`503` (waiting `Retry-After` when present,
 * else a short backoff — either way, jittered). A timeout or network error is
 * not retried — it throws the native error as-is, not an `HttpError`. Any
 * other non-ok, non-`okStatuses` response throws an `HttpError`.
 */
export async function httpGet(url: string, opts: HttpGetOptions = {}): Promise<Response> {
  const { headers, timeoutMs = 30_000, fetchImpl = fetch, okStatuses = [], maxRetryWaitMs = MAX_RETRY_WAIT_MS } = opts;
  let totalBaseWaitMs = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok || okStatuses.includes(res.status)) return res;
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    const baseWaitMs = retryAfterMs ?? BASE_BACKOFF_MS * 2 ** (attempt - 1);
    // The cap is on the total (un-jittered) base wait across every attempt,
    // not each attempt in isolation — 3 retries of a 60s Retry-After would
    // otherwise sleep ~3x the cap in total. Checked against the un-jittered
    // base so jitter can't push a wait just under the limit over it (or vice
    // versa).
    const retryable = (res.status === 429 || res.status === 503) && totalBaseWaitMs + baseWaitMs <= maxRetryWaitMs;
    if (retryable && attempt <= MAX_RETRIES) {
      totalBaseWaitMs += baseWaitMs;
      await res.body?.cancel().catch(() => {});
      await delay(jitteredDelayMs(baseWaitMs));
      continue;
    }
    await res.body?.cancel().catch(() => {});
    throw new HttpError(`GET ${url} -> ${res.status} ${res.statusText}`, {
      status: res.status,
      url,
      attempts: attempt,
      retryAfterMs,
    });
  }
}
