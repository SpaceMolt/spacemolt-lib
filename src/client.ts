/**
 * Multi-account client.
 *
 * Manages N authenticated `Account` connections, persisting their credentials
 * through a pluggable `CredentialStore`. Connecting many accounts is staggered
 * to stay under the server's per-IP login/connection rate limits — the server
 * itself advises "reuse one session per bot for its lifetime", so the intended
 * pattern is: add accounts once, `connectAll()` at startup, keep them open.
 */

import { Account } from './account.ts';
import {
  type AuthCredentials,
  type CredentialStore,
  MemoryCredentialStore,
  type StoredAccount,
} from './auth/credentials.ts';
import type { WebSocketFactory } from './transport/socket.ts';
import type { ReconnectOptions, RegisterParams, RegisterResult } from './account.ts';
import { CatalogCache } from './data/catalog.ts';
import { MapCache, httpBaseFromWs } from './data/map.ts';
import { ClerkSource, type ClerkPlayer } from './auth/clerk.ts';
import { CLOSE_CODE, type ConnectionClosedError, retryAfterMsFromClose } from './errors.ts';

const DEFAULT_HTTP_BASE = 'https://game.spacemolt.com';

export interface SpacemoltClientOptions {
  /** WebSocket URL of the v2 endpoint. */
  url?: string;
  /** Where credentials live. Defaults to an in-memory store. */
  store?: CredentialStore;
  /** Inject a WebSocket implementation (tests, custom runtimes). */
  webSocketFactory?: WebSocketFactory;
  /** Seed each account's state cache after auth (see Account). Default true. */
  seedState?: boolean;
  /**
   * Delay between connecting accounts. Default is derived from
   * `connectBatchSize` (`60_000 / connectBatchSize` — 600ms for the default
   * batch size of 100), guaranteeing a batch can't finish in under a minute
   * regardless of how fast each connect() actually completes — a flat
   * 250ms doesn't guarantee that (see `connectIds`). Set explicitly to
   * override that computed default with your own value (trusted as-is, not
   * a floor) — e.g. for a smaller test fleet where finishing fast is fine.
   */
  connectStaggerMs?: number;
  /**
   * Max accounts to connect before pausing for `connectBatchWaitMs`, so a
   * fleet never actually trips the server's per-IP WS-connection rate limit
   * (hitting it risks an IP-level timeout/ban on repeat offense — better to
   * never ask). Matches the server's default connection cap (100/min), so a
   * fleet at or under this size behaves exactly like a single stagger pass,
   * same as before; a larger fleet connects in batches of this size instead.
   * Default 100.
   */
  connectBatchSize?: number;
  /**
   * Pause between batches once `connectBatchSize` is exceeded, letting the
   * server's per-IP rate-limit window (1 minute by default) fully roll over
   * before the next batch starts. Default 65000 (65s — a margin over the
   * server's 1-minute window).
   */
  connectBatchWaitMs?: number;
  /**
   * Reconnect an account after an unexpected disconnect (a dropped
   * WebSocket after it was already connected — see `connectRetry` for the
   * initial connect instead). Default `true`. Driven by the client itself
   * (not each `Account`'s own standalone reconnect logic), reconnecting the
   * *same* `Account` instance in place (`Account.reconnectOnce` — fresh
   * socket, re-authenticated, subscriptions restored) rather than replacing
   * it, so anything holding a direct reference (e.g. a running loop) keeps
   * working transparently. Paced through the same rate-limited queue used
   * for the initial connect — see `handleAccountDisconnected` — so a mass
   * disconnect (e.g. every account dropped at once by a game-server restart)
   * reconnects the fleet through the same `connectBatchSize`/
   * `connectStaggerMs`/`connectBatchWaitMs` pacing, instead of every account
   * racing an independent timer. Pass `false` to leave a dropped account
   * disconnected instead (see `onAccountDisconnected`). If you pass a
   * `ReconnectOptions` object, only its truthiness matters — reconnect
   * pacing comes from `connectRetry` (the same backoff config used for the
   * initial connect), not this option's own `maxRetries`/`baseDelayMs`/
   * `maxDelayMs`. Never reconnects after a deliberate `close()`/`remove()`,
   * a `session_replaced`, or an `auth_timeout`. Token-only accounts can't
   * reconnect (the token is single-use).
   */
  reconnect?: boolean | ReconnectOptions;
  /** HTTP origin for bulk data fetches. Defaults to the origin of `url`. */
  httpBaseUrl?: string;
  /**
   * How long `catalog()` serves its cached copy before revalidating against the
   * server. The catalog only changes on a server release, but a long-lived
   * client that fetched it once at startup would otherwise keep serving that
   * copy indefinitely — days stale across a release. Past this age the next
   * `catalog()` call revalidates conditionally (`If-None-Match`): an unchanged
   * catalog is a ~0-byte `304` (near-free), a changed one is re-downloaded.
   * Matches the server's own `max-age`. Default 3600000 (1h). Set `0` to
   * revalidate on every call, or `Infinity` to cache for the client's lifetime
   * (the old fetch-once behavior).
   */
  catalogMaxAgeMs?: number;
  /**
   * Clerk API key for `connectOwned()` / `listOwnedPlayers()` — connect every
   * game account the Clerk user owns without storing per-account passwords.
   * Generate one from the website; keep it secret.
   */
  clerkApiKey?: string;
  /** Inject a `fetch` implementation (tests, custom runtimes). */
  fetchImpl?: typeof fetch;
  /**
   * How long to wait for the server's `welcome` frame (post-WS-upgrade) and
   * for a `logged_in`/error response to an auth attempt, before giving up.
   * Without this, a connection the server silently never completes (accepts
   * the WS upgrade but never responds) hangs forever with no error and no
   * retry — this can't be told apart from "still connecting" from the
   * outside. Default 15000 (15s — generous over the ~150-300ms a healthy
   * connect actually takes, per live measurement).
   */
  connectTimeoutMs?: number;
  /**
   * How long to wait for a query's response before giving up. Unlike a
   * mutation (which can legitimately take minutes, e.g. a travel/jump's
   * transit time), a query has no legitimate reason to take long — bounding
   * it turns a silently-dropped response into a clean error instead of a
   * permanent hang. Default 15000 (15s).
   */
  queryTimeoutMs?: number;
  /**
   * How long to wait, after a mutation's pending ack arrives, for its final
   * `action_result`/`action_error` outcome before giving up. Generous by
   * design — some mutations legitimately take many ticks (a jump/travel's
   * transit time is distance-based and can run minutes) — but not infinite:
   * without this, a single silently-dropped outcome frame hangs forever AND
   * wedges every subsequent mutation on that account behind it (mutations
   * are serialized per account). Default 600000 (10 minutes).
   */
  mutationTimeoutMs?: number;
  /**
   * Fallback safety net: retry a failed `connect()` (the raw WebSocket
   * handshake, before any auth frame) with backoff instead of dropping the
   * account. `connectBatchSize`/`connectBatchWaitMs` above are the primary
   * defense — they're sized to avoid ever tripping the server's per-IP
   * WS-connection rate limit in the first place — but this covers the
   * unexpected case anyway (e.g. other traffic sharing the IP eating into
   * the budget), since a 429 on the handshake surfaces as a plain
   * `ConnectionClosedError` — not a `SpacemoltError` with `code:
   * 'rate_limited'` — so it can't be told apart from a genuine connection
   * failure and isn't covered by `Account`'s targeted rate-limit retry.
   * Default `true` (enabled). Pass `false` to disable and fail fast instead.
   */
  connectRetry?: boolean | ReconnectOptions;
}

const DEFAULT_CONNECT_RETRY: Required<ReconnectOptions> = { maxRetries: 8, baseDelayMs: 2000, maxDelayMs: 60_000 };

/** Assumed length of the server's per-IP WS-connection rate-limit window. */
const CONNECT_RATE_WINDOW_MS = 60_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SpacemoltClient {
  private readonly store: CredentialStore;
  private readonly connected = new Map<string, Account>();
  private catalogCache?: CatalogCache;
  private catalogFetchedAt = 0;
  private mapCache?: MapCache;
  private clerkSource?: ClerkSource;
  private readonly accountConnectedListeners = new Set<(account: Account) => void>();
  private readonly accountReconnectedListeners = new Set<(account: Account) => void>();
  private readonly accountDisconnectedListeners = new Set<(id: string, err: ConnectionClosedError) => void>();
  /** Paced by connectBatchSize/connectStaggerMs/connectBatchWaitMs — the same limiter drains both the initial fleet connect and later reconnects, see `enqueueRateLimited`. */
  private readonly rateLimitedQueue: Array<() => Promise<void>> = [];
  private rateLimitedQueueDraining = false;
  /**
   * Ids currently mid-reconnect. Guards against a socket dropping again
   * *during* `reconnectAccountInPlace` (e.g. another rate-limit close before
   * auth completes) re-firing `handleAccountDisconnected` and enqueuing a
   * second, parallel reconnect chain for the same id — the drop instead
   * surfaces as a failure inside the one already-running `withConnectRetry`
   * loop, which retries it itself.
   */
  private readonly reconnectingIds = new Set<string>();

  constructor(private readonly opts: SpacemoltClientOptions = {}) {
    this.store = opts.store ?? new MemoryCredentialStore();
  }

  /**
   * Fires the first time an id becomes a connected+authenticated `Account`
   * instance — the initial connect (`connect`/`connectAll`/`connectOwned`/
   * `register`). Does NOT fire again for a later reconnect after an
   * unexpected disconnect — that reuses the same instance in place (see
   * `Account.reconnectOnce`) rather than creating a new one, so there's
   * nothing new to index/re-wire; see `onAccountReconnected` for that event
   * instead. Unlike `connectAll`'s/`connectOwned`'s per-call `onConnect`
   * option (scoped to that one call), this is a persistent subscription.
   * Returns an unsubscribe function.
   */
  onAccountConnected(listener: (account: Account) => void): () => void {
    this.accountConnectedListeners.add(listener);
    return () => this.accountConnectedListeners.delete(listener);
  }

  /**
   * Fires after an already-connected account's connection is restored
   * following an unexpected disconnect — the same `Account` instance
   * throughout, reconnected in place. Purely informational (e.g. logging);
   * nothing needs re-indexing since the instance never changed. Returns an
   * unsubscribe function.
   */
  onAccountReconnected(listener: (account: Account) => void): () => void {
    this.accountReconnectedListeners.add(listener);
    return () => this.accountReconnectedListeners.delete(listener);
  }

  /**
   * Fires when an account is dropped for good: a terminal close (session
   * replaced by another connection, or an auth timeout) that this client
   * deliberately does not reconnect after, or a reconnect attempt that
   * exhausted its retries. Silent otherwise today — this is the only
   * visibility a caller has into that. Returns an unsubscribe function.
   */
  onAccountDisconnected(listener: (id: string, err: ConnectionClosedError) => void): () => void {
    this.accountDisconnectedListeners.add(listener);
    return () => this.accountDisconnectedListeners.delete(listener);
  }

  private notifyAccountConnected(account: Account): void {
    for (const listener of this.accountConnectedListeners) listener(account);
  }

  private notifyAccountReconnected(account: Account): void {
    for (const listener of this.accountReconnectedListeners) listener(account);
  }

  private notifyAccountDisconnected(id: string, err: ConnectionClosedError): void {
    for (const listener of this.accountDisconnectedListeners) listener(id, err);
  }

  /** HTTP origin used for bulk data fetches (catalog, map). */
  get httpBaseUrl(): string {
    return this.opts.httpBaseUrl ?? (this.opts.url ? httpBaseFromWs(this.opts.url) : DEFAULT_HTTP_BASE);
  }

  /**
   * The bulk catalog. Fetched on first use and cached, then revalidated against
   * the server once the cache is older than `catalogMaxAgeMs` (default 1h) so a
   * long-lived client picks up a new catalog after a server release instead of
   * serving a days-stale copy. Revalidation is conditional (`If-None-Match`), so
   * an unchanged catalog costs a ~0-byte `304` and the cached instance is kept.
   * Pass `force` to refetch unconditionally now.
   */
  async catalog(force = false): Promise<CatalogCache> {
    const maxAgeMs = this.opts.catalogMaxAgeMs ?? 3_600_000;
    const cached = this.catalogCache;
    const fresh = cached && !force && Date.now() - this.catalogFetchedAt < maxAgeMs;
    if (fresh) return cached;

    this.catalogCache =
      !this.catalogCache || force
        ? await CatalogCache.load(this.httpBaseUrl)
        : await this.catalogCache.revalidate(this.httpBaseUrl);
    this.catalogFetchedAt = Date.now();
    return this.catalogCache;
  }

  /** The static galaxy map, fetched once and cached. Pass `force` to refetch. */
  async map(force = false): Promise<MapCache> {
    if (force || !this.mapCache) this.mapCache = await MapCache.load(this.httpBaseUrl);
    return this.mapCache;
  }

  /** The credential store backing this client. */
  get credentialStore(): CredentialStore {
    return this.store;
  }

  // --- credential management (persist; does not connect) ---

  /** Persist username/password credentials. Returns the account id (username). */
  async addLogin(username: string, password: string): Promise<string> {
    await this.store.put({ id: username, credentials: { kind: 'login', username, password } });
    return username;
  }

  /** Persist a login-token credential under an explicit id. */
  async addToken(id: string, token: string): Promise<string> {
    await this.store.put({ id, credentials: { kind: 'login_token', token } });
    return id;
  }

  // --- connecting ---

  /**
   * Register a brand-new account: connect, register, and persist the generated
   * password as login credentials (keyed by username) for future sessions.
   */
  async register(params: RegisterParams): Promise<{ account: Account; result: RegisterResult }> {
    const account = this.createAccount(params.username);
    this.connected.set(params.username, account);
    try {
      await account.connect();
      const result = await account.register(params);
      await this.store.put({
        id: params.username,
        credentials: { kind: 'login', username: params.username, password: result.password },
        playerId: result.player_id,
      });
      account.onDisconnected((err) => this.handleAccountDisconnected(params.username, account, err));
      this.notifyAccountConnected(account);
      return { account, result };
    } catch (error) {
      account.close();
      this.connected.delete(params.username);
      throw error;
    }
  }

  /** Resolves `connectRetry` into a concrete backoff config. */
  private connectRetryConfig(): Required<ReconnectOptions> {
    const retryOpt = this.opts.connectRetry ?? true;
    if (retryOpt === false) return { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 };
    return { ...DEFAULT_CONNECT_RETRY, ...(retryOpt === true ? {} : retryOpt) };
  }

  /**
   * Retry `attempt` with the shared `connectRetry` backoff, honoring a 4003
   * `connection_rate_limited` close's `retry_after` hint over the
   * exponential fallback. Shared by the initial connect (`connect`) and an
   * in-place reconnect (`reconnectAccountInPlace`) so both back off
   * identically.
   */
  private async withConnectRetry<T>(attempt: () => Promise<T>): Promise<T> {
    const retry = this.connectRetryConfig();
    let lastErr: unknown;
    for (let i = 0; i <= retry.maxRetries; i++) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        if (i < retry.maxRetries) {
          const retryAfterMs = retryAfterMsFromClose(err);
          await delay(retryAfterMs ?? Math.min(retry.baseDelayMs * 2 ** i, retry.maxDelayMs));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Connect and authenticate one stored account. Idempotent per id.
   *
   * Retries the whole connect+authenticate sequence with backoff on failure
   * (see `connectRetry`) — a fleet large enough to exceed the per-IP
   * WS-connection rate limit sees some accounts rejected at the handshake,
   * which self-heals once the server's rate-limit window rolls over.
   */
  async connect(id: string): Promise<Account> {
    const existing = this.connected.get(id);
    if (existing) return existing;
    const stored = await this.store.get(id);
    if (!stored) throw new Error(`no stored credentials for account "${id}"`);

    return this.withConnectRetry(async () => {
      const account = this.createAccount(id);
      this.connected.set(id, account);
      try {
        await account.connect();
        await account.authenticate(stored.credentials);
        await this.capturePlayerId(stored);
        // Only start listening for a later drop once the account has
        // actually completed its first successful connect — a close
        // *during* this attempt is `connectRetry`'s job (the catch block
        // below), not a reconnect-after-established-connection event; wiring
        // this any earlier raced this same attempt's own retry loop with a
        // second, uncoordinated one triggered by the very close that just
        // failed it.
        account.onDisconnected((err) => this.handleAccountDisconnected(id, account, err));
        this.notifyAccountConnected(account);
        return account;
      } catch (err) {
        this.connected.delete(id);
        account.close();
        throw err;
      }
    });
  }

  /** Connect every stored account, staggered to respect rate limits. */
  async connectAll(opts: { onConnect?: (account: Account) => void } = {}): Promise<Account[]> {
    const stored = await this.store.list();
    return this.connectIds(
      stored.map((s) => s.id),
      opts.onConnect,
    );
  }

  // --- Clerk multi-account (connect every account you own) ---

  /** List the player accounts the Clerk user owns. Requires `clerkApiKey`. */
  async listOwnedPlayers(): Promise<ClerkPlayer[]> {
    return this.requireClerkSource().listPlayers();
  }

  /**
   * Connect every account the Clerk user owns (optionally filtered), staggered
   * to respect rate limits. Stores a `clerk` credential per player — each
   * account mints a fresh single-use WS token on connect and reconnect, so no
   * passwords are persisted. Requires `clerkApiKey`.
   *
   * A fleet-wide call can legitimately take minutes (see `connectIds`'s
   * pacing) — `onConnect` fires as each account finishes, so a caller can
   * index/use accounts incrementally instead of only after the whole batch
   * settles (the returned promise still doesn't resolve until every account
   * has been attempted).
   */
  async connectOwned(
    opts: { filter?: (player: ClerkPlayer) => boolean; onConnect?: (account: Account) => void } = {},
  ): Promise<Account[]> {
    const source = this.requireClerkSource();
    const players = await source.listPlayers();
    const selected = opts.filter ? players.filter(opts.filter) : players;
    const ids: string[] = [];
    for (const player of selected) {
      await this.store.put({
        id: player.username,
        credentials: {
          kind: 'clerk',
          apiKey: source.apiKey,
          playerId: player.id,
          httpBaseUrl: source.httpBaseUrl,
        },
        playerId: player.id,
      });
      ids.push(player.username);
    }
    return this.connectIds(ids, opts.onConnect);
  }

  private requireClerkSource(): ClerkSource {
    if (!this.clerkSource) {
      if (!this.opts.clerkApiKey) {
        throw new Error('connectOwned/listOwnedPlayers require `clerkApiKey` in SpacemoltClientOptions');
      }
      this.clerkSource = new ClerkSource({
        apiKey: this.opts.clerkApiKey,
        httpBaseUrl: this.httpBaseUrl,
        fetchImpl: this.opts.fetchImpl,
      });
    }
    return this.clerkSource;
  }

  /**
   * Connect the given stored ids, staggered to respect rate limits. At or
   * under `connectBatchSize` accounts this is a single stagger pass — the
   * same behavior as before batching existed. Past that, it pauses for
   * `connectBatchWaitMs` between batches so the fleet never actually asks
   * for more connections than the server's per-IP window allows. A single
   * account failing to connect must not abort the rest of the batch — it's
   * logged and skipped so the caller still gets every account that succeeded.
   *
   * `onConnect` fires synchronously as each id finishes (success only) so a
   * caller managing many accounts (e.g. indexing them for lookup) doesn't
   * have to wait for the entire — potentially minutes-long — batch before
   * any single account becomes usable.
   *
   * Pacing itself is `enqueueRateLimited` — the same queue a later
   * reconnect (see `handleAccountDisconnected`) competes for a slot in, so a
   * reconnect landing mid-batch is paced fairly alongside the rest of the
   * fleet instead of racing it on a separate timer.
   */
  private async connectIds(ids: string[], onConnect?: (account: Account) => void): Promise<Account[]> {
    const accounts: Account[] = [];
    await Promise.all(
      ids.map((id) =>
        this.enqueueRateLimited(() => this.connect(id))
          .then((account) => {
            accounts.push(account);
            onConnect?.(account);
          })
          .catch((err: unknown) => {
            console.warn(`[spacemolt] failed to connect "${id}": ${err}`);
          }),
      ),
    );
    return accounts;
  }

  /**
   * Enqueues `task`, paced by `connectBatchSize`/`connectStaggerMs`/
   * `connectBatchWaitMs` — the single rate limiter shared by the initial
   * fleet connect (`connectIds`) and every later reconnect
   * (`handleAccountDisconnected`), so the server's per-IP WS-connection cap
   * is respected by one mechanism, not a parallel one for each case. Returns
   * a promise settling with `task`'s own outcome once its turn comes up.
   */
  private enqueueRateLimited<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.rateLimitedQueue.push(async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        }
      });
      void this.drainRateLimitedQueue();
    });
  }

  private async drainRateLimitedQueue(): Promise<void> {
    if (this.rateLimitedQueueDraining) return;
    this.rateLimitedQueueDraining = true;
    // Default stagger is derived from batchSize so a full batch can never
    // finish in under a minute regardless of how fast each connect() call
    // actually completes. A flat 250ms alone doesn't guarantee this: 100
    // accounts at 250ms apart, plus a healthy ~150-300ms connect time each,
    // finishes in ~45s — silently exceeding the server's 100/min per-IP
    // WS-connection cap (verified live: connecting 100 accounts this fast
    // trips it, hanging accounts 101+ instead of a clean rejection). An
    // explicit connectStaggerMs is trusted as the caller's deliberate
    // override, same as connectBatchSize <= 0 already opts out of batching
    // protection entirely.
    const batchSize = this.opts.connectBatchSize ?? 100;
    const stagger = this.opts.connectStaggerMs ?? (batchSize > 0 ? Math.ceil(CONNECT_RATE_WINDOW_MS / batchSize) : 250);
    const batchWaitMs = this.opts.connectBatchWaitMs ?? 65_000;
    let ranInCurrentBatch = 0;
    let isFirst = true;
    while (this.rateLimitedQueue.length > 0) {
      if (!isFirst) {
        if (batchSize > 0 && ranInCurrentBatch >= batchSize) {
          await delay(batchWaitMs);
          ranInCurrentBatch = 0;
        } else if (stagger > 0) {
          await delay(stagger);
        }
      }
      isFirst = false;
      const task = this.rateLimitedQueue.shift();
      if (!task) break;
      ranInCurrentBatch++;
      await task();
    }
    this.rateLimitedQueueDraining = false;
  }

  // --- access ---

  /** The connected account for an id, if connected. */
  account(id: string): Account | undefined {
    return this.connected.get(id);
  }
  /** All currently-connected accounts. */
  accounts(): Account[] {
    return [...this.connected.values()];
  }
  /** Ids of all currently-connected accounts. */
  ids(): string[] {
    return [...this.connected.keys()];
  }

  /** Close and forget an account, and remove its stored credentials. */
  async remove(id: string): Promise<void> {
    this.connected.get(id)?.close();
    this.connected.delete(id);
    await this.store.remove(id);
  }

  /** Close every connection (credentials remain in the store). */
  closeAll(): void {
    for (const account of this.connected.values()) account.close();
    this.connected.clear();
  }

  // --- internals ---

  /**
   * Reconnection for a client-managed account is driven here, not by the
   * `Account`'s own (disabled — see `createAccount`) reconnect logic: an
   * unexpected disconnect closes every affected account at once (e.g. a
   * game-server restart), and reconnecting through the same rate-limited
   * queue used for the initial connect — instead of each account racing its
   * own independent timer — is what keeps a mass reconnect from re-tripping
   * the server's per-IP WS-connection rate limit right as it recovers.
   *
   * Reconnects in place (`Account.reconnectOnce`, same instance) rather than
   * replacing the account with a new one: anything holding a direct
   * reference to this `Account` (e.g. a running loop, which captures it once
   * at start) keeps working transparently once the connection is restored,
   * instead of being welded to a now-dead instance nobody is driving.
   */
  private handleAccountDisconnected(id: string, account: Account, err: ConnectionClosedError): void {
    // A newer instance (the account was removed) has already superseded
    // this one, or a reconnect is already in flight for it — a socket
    // dropping again *during* reconnectAccountInPlace (e.g. another
    // rate-limit close before auth completes) re-fires this same listener
    // on the same persistent instance; without this check it would enqueue
    // a second, parallel reconnect chain instead of letting the one already
    // running retry it.
    if (this.connected.get(id) !== account || this.reconnectingIds.has(id)) {
      return;
    }

    // session_replaced: another connection took our slot — reconnecting
    // would just fight it. auth_timeout: we failed to auth in time. Neither
    // is worth retrying (mirrors Account.shouldReconnect's old per-account
    // logic, now made here instead since the client owns this decision).
    const terminal = err.code === CLOSE_CODE.SESSION_REPLACED || err.code === CLOSE_CODE.AUTH_TIMEOUT;
    if (terminal || this.opts.reconnect === false) {
      this.connected.delete(id);
      this.notifyAccountDisconnected(id, err);
      return;
    }

    this.reconnectingIds.add(id);
    void this.enqueueRateLimited(() => this.withConnectRetry(() => account.reconnectOnce()))
      .then(() => this.notifyAccountReconnected(account))
      .catch((reconnectErr: unknown) => {
        console.warn(`[spacemolt] failed to reconnect "${id}": ${reconnectErr}`);
        this.connected.delete(id);
        this.notifyAccountDisconnected(id, err);
      })
      .finally(() => this.reconnectingIds.delete(id));
  }

  private createAccount(id: string): Account {
    const account = new Account({
      id,
      url: this.opts.url,
      webSocketFactory: this.opts.webSocketFactory,
      seedState: this.opts.seedState,
      // The client owns reconnection for its managed accounts (see
      // handleAccountDisconnected) instead of each Account reconnecting
      // independently — always false here regardless of
      // SpacemoltClientOptions.reconnect, which now only controls whether
      // the *client* reconnects a dropped account, not how the Account
      // itself would.
      reconnect: false,
      fetchImpl: this.opts.fetchImpl,
      connectTimeoutMs: this.opts.connectTimeoutMs,
      queryTimeoutMs: this.opts.queryTimeoutMs,
      mutationTimeoutMs: this.opts.mutationTimeoutMs,
      credentials: async () => {
        const stored = await this.store.get(id);
        if (!stored) throw new Error(`no stored credentials for account "${id}"`);
        return stored.credentials;
      },
    });
    return account;
  }

  private async capturePlayerId(stored: StoredAccount): Promise<void> {
    const playerId = this.connected.get(stored.id)?.player?.id;
    if (playerId && playerId !== stored.playerId) {
      await this.store.put({ ...stored, playerId });
    }
  }
}

export type { AuthCredentials, CredentialStore, StoredAccount };
