/**
 * A single authenticated SpaceMolt connection.
 *
 * Owns one WebSocket, performs raw-credential auth, and exposes the
 * query/mutation command API, the local state cache (M2), and the typed push
 * event system + market/observation subscriptions (M3).
 *
 * Auth frames (`registered`, `logged_in`) are handled out-of-band from the
 * `request_id` correlator: after `register` the `logged_in` frame is an
 * unsolicited push with no `request_id`, so auth is sequenced by frame type
 * instead (only one auth exchange is ever in flight on a connection).
 */

import { ACTIONS } from './generated/actions.gen.ts';
import { buildCommands, type Commands } from './generated/commands.gen.ts';
import type { AuthCredentials } from './auth/credentials.ts';
import { mintWsToken } from './auth/clerk.ts';
import type {
  NotificationMarketUpdate,
  NotificationObservationUpdate,
  SubscribeMarketResponse,
  SubscribeObservationResponse,
  V2GameState,
} from './generated/openapi/types.gen.ts';
import type { NotificationPayloads, TypedNotificationType } from './generated/notifications.gen.ts';
import { ConnectionClosedError, errorFromFrame, SpacemoltError } from './errors.ts';
import { TypedEmitter } from './events/emitter.ts';
import { MarketCache, type MarketBook } from './state/market.ts';
import { ObservationCache, type ObservationView } from './state/observation.ts';
import type {
  ActionResultFrame,
  ErrorFrame,
  GameState,
  LoggedInFrame,
  MutationAck,
  MutationResult,
  QueryResult,
  RawFrame,
  RegisteredFrame,
  StateSection,
  WelcomeFrame,
} from './protocol.ts';
import { StateCache } from './state/cache.ts';
import { Correlator } from './transport/correlator.ts';
import { Socket, type WebSocketFactory } from './transport/socket.ts';

export type LoggedInPayload = Record<string, unknown>;

export interface ReconnectOptions {
  /** Max reconnect attempts before giving up and emitting `disconnected`. Default 10. */
  maxRetries?: number;
  /** Base backoff in ms (doubles per attempt). Default 1000. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms. Default 30000. */
  maxDelayMs?: number;
}

export interface AccountOptions {
  /** WebSocket URL of the v2 endpoint. Defaults to the production server. */
  url?: string;
  /** Inject a WebSocket implementation (tests, custom runtimes). */
  webSocketFactory?: WebSocketFactory;
  /**
   * After authenticating, issue a `get_status` query to seed the local state
   * cache with the canonical full state. Default `true`. Disable to avoid the
   * extra round-trip; the cache then fills from the first mutation delta.
   */
  seedState?: boolean;
  /**
   * Auto-reconnect + re-auth on an unexpected disconnect. Requires
   * `credentials`. Off unless enabled. Never reconnects after a deliberate
   * `close()`, a `session_replaced` (4001), or an `auth_timeout` (4002).
   */
  reconnect?: boolean | ReconnectOptions;
  /**
   * Supplies credentials for re-auth on reconnect. `login_token` credentials
   * are single-use and can't reconnect; `clerk` credentials re-mint a fresh
   * token each time, so they reconnect cleanly.
   */
  credentials?: () => AuthCredentials | Promise<AuthCredentials>;
  /** Inject a `fetch` implementation, used by `clerk` auth (tests, runtimes). */
  fetchImpl?: typeof fetch;
  /** Max automatic retries when a command is `rate_limited`. Default 5. */
  maxRateLimitRetries?: number;
}

export interface RegisterParams {
  username: string;
  empire: string;
  registration_code?: string;
}

export interface RegisterResult {
  /** 256-bit hex credential — store it; it cannot be recovered. */
  password: string;
  player_id: string;
  /** Full initial game state from the following `logged_in` frame. */
  state: LoggedInPayload;
}

interface PendingAuth {
  onLoggedIn: (payload: LoggedInPayload, registered?: RegisteredFrame['payload']) => void;
  onError: (err: SpacemoltError) => void;
  registered?: RegisteredFrame['payload'];
}

const DEFAULT_URL = 'wss://game.spacemolt.com/ws/v2';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeReconnect(opt: AccountOptions['reconnect']): Required<ReconnectOptions> | null {
  if (!opt) return null;
  const o = typeof opt === 'object' ? opt : {};
  return {
    maxRetries: o.maxRetries ?? 10,
    baseDelayMs: o.baseDelayMs ?? 1000,
    maxDelayMs: o.maxDelayMs ?? 30000,
  };
}

/** Parse a retry interval from a `rate_limited` error (ms). */
function retryAfterMs(err: SpacemoltError): number {
  const fromDetails = typeof err.details?.['retry_after'] === 'number' ? (err.details['retry_after'] as number) : undefined;
  const match = err.message.match(/retry in (\d+)\s*second/i);
  const seconds = fromDetails ?? (match ? Number(match[1]) : undefined);
  return Math.max(250, (seconds ?? 1) * 1000);
}

export class Account {
  private socket!: Socket;
  private readonly correlator = new Correlator();
  private readonly cache = new StateCache();
  private readonly emitter = new TypedEmitter();
  private readonly marketCache = new MarketCache();
  private readonly observationCache = new ObservationCache();
  private readonly seedState: boolean;
  private readonly url: string;
  private readonly webSocketFactory?: WebSocketFactory;
  private readonly reconnectConfig: Required<ReconnectOptions> | null;
  private readonly credentialsProvider?: () => AuthCredentials | Promise<AuthCredentials>;
  private readonly fetchImpl?: typeof fetch;
  private readonly maxRateLimitRetries: number;
  private requestSeq = 0;

  private _welcome: WelcomeFrame['payload'] | null = null;
  private _authenticated = false;
  private _loginPayload: LoggedInPayload | null = null;
  private _commands: Commands | null = null;
  private welcomeWaiter: ((w: WelcomeFrame['payload']) => void) | null = null;
  private pendingAuth: PendingAuth | null = null;
  private stateListener: ((changed: StateSection[]) => void) | null = null;

  // resilience state
  private userClosing = false;
  private reconnecting = false;
  private mutationLane: Promise<unknown> = Promise.resolve();
  private marketSubscribed = false;
  private observationSubscribed = false;
  private observationActiveScan = false;
  private reconnectedListener: (() => void) | null = null;
  private reconnectingListener: ((attempt: number) => void) | null = null;
  private disconnectedListener: ((err: ConnectionClosedError) => void) | null = null;

  constructor(opts: AccountOptions = {}) {
    this.seedState = opts.seedState ?? true;
    this.url = opts.url ?? DEFAULT_URL;
    this.webSocketFactory = opts.webSocketFactory;
    this.credentialsProvider = opts.credentials;
    this.fetchImpl = opts.fetchImpl;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 5;
    this.reconnectConfig = normalizeReconnect(opts.reconnect);
    this.makeSocket();

    // Keep the subscription caches current as their pushes arrive. Registered
    // before any user listener so the cache is updated first.
    this.emitter.on('market_update', (p) => this.marketCache.applyUpdate(p as NotificationMarketUpdate));
    this.emitter.on('observation_update', (p) =>
      this.observationCache.applyUpdate(p as NotificationObservationUpdate),
    );
  }

  private makeSocket(): void {
    this.socket = new Socket({ url: this.url, webSocketFactory: this.webSocketFactory });
    this.socket.onFrame = (frame) => this.routeFrame(frame);
    this.socket.onClose = (err) => this.handleClose(err);
  }

  /** Live view of the cached game state. Treat as read-only. */
  get state(): Readonly<GameState> {
    return this.cache.snapshot();
  }

  get player(): GameState['player'] {
    return this.cache.player;
  }
  get ship(): GameState['ship'] {
    return this.cache.ship;
  }
  get location(): GameState['location'] {
    return this.cache.location;
  }
  get cargo(): GameState['cargo'] {
    return this.cache.cargo;
  }
  get skills(): GameState['skills'] {
    return this.cache.skills;
  }
  get credits(): number | undefined {
    return this.cache.credits;
  }
  /** True when a tick-deferred action is queued for this account. */
  get hasPendingAction(): boolean {
    return this.cache.hasPendingAction;
  }

  /** The raw `logged_in` payload from the last successful auth (login extras). */
  get loginPayload(): LoggedInPayload | null {
    return this._loginPayload;
  }

  /**
   * Typed, generated command facade grouped by tool:
   * `account.commands.spacemolt.jump({ id: 'sol' })`,
   * `account.commands.spacemolt_market.view_market({ item_id: 'iron_ore' })`.
   * Each method dispatches through `send`, so pacing and the state cache apply.
   */
  get commands(): Commands {
    if (!this._commands) {
      this._commands = buildCommands((tool, action, payload) => this.send(tool, action, payload));
    }
    return this._commands;
  }

  /** The server's `welcome` payload, available after `connect()` resolves. */
  get welcome(): WelcomeFrame['payload'] | null {
    return this._welcome;
  }

  get authenticated(): boolean {
    return this._authenticated;
  }

  /** Open the connection and resolve once the `welcome` frame arrives. */
  connect(): Promise<WelcomeFrame['payload']> {
    return this.open();
  }

  private async open(): Promise<WelcomeFrame['payload']> {
    this._welcome = null;
    await this.socket.connect();
    if (this._welcome) return this._welcome;
    return new Promise<WelcomeFrame['payload']>((resolve) => {
      this.welcomeWaiter = resolve;
    });
  }

  /** Register a new account; resolves with the generated credentials + state. */
  async register(params: RegisterParams): Promise<RegisterResult> {
    const result = await new Promise<RegisterResult>((resolve, reject) => {
      this.beginAuth((state, registered) => {
        if (!registered) {
          reject(new SpacemoltError('missing_credentials', 'register succeeded but no credentials frame was received'));
          return;
        }
        resolve({ password: registered.password, player_id: registered.player_id, state });
      }, reject);
      this.sendFrame('spacemolt_auth', 'register', { ...params }, this.nextRequestId());
    });
    this._loginPayload = result.state;
    await this.maybeSeedState();
    return result;
  }

  /** Authenticate an existing account with username + password. */
  login(params: { username: string; password: string }): Promise<LoggedInPayload> {
    return this.authExchange('login', { ...params });
  }

  /** Authenticate with a short-lived single-use token (web/Clerk path). */
  loginToken(token: string): Promise<LoggedInPayload> {
    return this.authExchange('login_token', { token });
  }

  /** Authenticate from a stored `AuthCredentials` (dispatches by kind). */
  async authenticate(creds: AuthCredentials): Promise<void> {
    switch (creds.kind) {
      case 'login':
        await this.login({ username: creds.username, password: creds.password });
        return;
      case 'login_token':
        await this.loginToken(creds.token);
        return;
      case 'clerk': {
        // Mint a fresh single-use WS token from the Clerk key, then log in with
        // it. Re-runs on every reconnect, so each connection gets a new token.
        const token = await mintWsToken({
          httpBaseUrl: creds.httpBaseUrl,
          apiKey: creds.apiKey,
          playerId: creds.playerId,
          fetchImpl: this.fetchImpl,
        });
        await this.loginToken(token);
        return;
      }
      case 'register':
        await this.register({
          username: creds.username,
          empire: creds.empire,
          registration_code: creds.registration_code,
        });
        return;
    }
  }

  /**
   * Re-seed the cache from the canonical full state (`get_status`). Returns the
   * cached state. Called automatically after auth unless `seedState` is false.
   */
  async refresh(): Promise<Readonly<GameState>> {
    const res = await this.query('spacemolt', 'get_status');
    const snapshot = res.structuredContent as V2GameState | undefined;
    if (snapshot) {
      const changed = this.cache.seed(snapshot);
      if (changed.length) this.stateListener?.(changed);
    }
    return this.cache.snapshot();
  }

  /** Register a listener fired with the sections that changed on each update. */
  onStateChange(listener: (changed: StateSection[]) => void): void {
    this.stateListener = listener;
  }

  /** Log out, releasing the connection's authenticated session. */
  async logout(): Promise<void> {
    await this.query('spacemolt_auth', 'logout');
    this._authenticated = false;
  }

  /**
   * Run a read-only command; resolves synchronously with the result.
   * Auto-retries on `rate_limited` (waiting the server's interval).
   */
  query(tool: string, action: string, payload?: Record<string, unknown>): Promise<QueryResult> {
    return this.withRateLimitRetry(() => {
      const requestId = this.nextRequestId();
      const promise = this.correlator.awaitQuery(requestId);
      this.sendFrame(tool, action, payload, requestId);
      return promise;
    });
  }

  /**
   * Run a mutation; resolves when the action executes on a later tick (after
   * the immediate pending ack). `onAck` fires when the pending ack arrives.
   *
   * Mutations are serialized per account — the next is sent only after the
   * previous resolves — because the server queues one action per tick and
   * rejects a concurrent mutation with `action_pending`. Also auto-retries on
   * `rate_limited`.
   */
  mutate(
    tool: string,
    action: string,
    payload?: Record<string, unknown>,
    onAck?: (ack: MutationAck) => void,
  ): Promise<MutationResult> {
    return this.enqueueMutation(() =>
      this.withRateLimitRetry(() => {
        const requestId = this.nextRequestId();
        const promise = this.correlator.awaitMutation(requestId, onAck);
        this.sendFrame(tool, action, payload, requestId);
        return promise;
      }),
    );
  }

  /**
   * Run a command, dispatching to `query`/`mutate` based on the spec's
   * `x-is-mutation` classification. Unknown commands are treated as queries.
   */
  send(tool: string, action: string, payload?: Record<string, unknown>): Promise<QueryResult | MutationResult> {
    const def = ACTIONS[`${tool}/${action}`];
    return def?.kind === 'mutation' ? this.mutate(tool, action, payload) : this.query(tool, action, payload);
  }

  /**
   * Listen for a specific server push by msg_type. The handler receives the
   * typed payload for published notification types, or a loosely-typed object
   * for not-yet-typed pushes. Returns an unsubscribe function.
   */
  on<K extends TypedNotificationType>(type: K, handler: (payload: NotificationPayloads[K]) => void): () => void;
  on(type: string, handler: (payload: Record<string, unknown>) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(type: string, handler: (payload: any) => void): () => void {
    return this.emitter.on(type, handler as (payload: unknown) => void);
  }

  /** Listen for every server push frame. Returns an unsubscribe function. */
  onAny(handler: (frame: RawFrame) => void): () => void {
    return this.emitter.onAny(handler);
  }

  /**
   * Async-iterate one push msg_type's payloads:
   * `for await (const msg of account.events('chat_message')) { ... }`.
   * Buffered, so a slow consumer won't drop frames; `break` unsubscribes.
   */
  events<K extends TypedNotificationType>(type: K): AsyncIterableIterator<NotificationPayloads[K]>;
  events(type: string): AsyncIterableIterator<Record<string, unknown>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events(type: string): AsyncIterableIterator<any> {
    return this.emitter.stream(type);
  }

  /** Async-iterate every push frame. */
  anyEvents(): AsyncIterableIterator<RawFrame> {
    return this.emitter.anyStream();
  }

  // --- subscriptions ---

  /**
   * Subscribe to the order book of the station you're docked at. Returns the
   * baseline snapshot and seeds the market cache; `market_update` pushes are
   * merged automatically. Read with `account.market(baseId)`.
   */
  async subscribeMarket(): Promise<SubscribeMarketResponse> {
    const res = await this.query('spacemolt_market', 'subscribe_market');
    const snapshot = res.structuredContent as SubscribeMarketResponse | undefined;
    if (snapshot) this.marketCache.seed(snapshot);
    this.marketSubscribed = true;
    return snapshot ?? ({} as SubscribeMarketResponse);
  }

  /** Unsubscribe from the current station's market and drop its cached book. */
  async unsubscribeMarket(): Promise<void> {
    const baseId = this.location?.docked_at ?? this.marketCache.bases()[0];
    this.marketSubscribed = false;
    await this.query('spacemolt_market', 'unsubscribe_market');
    if (baseId) this.marketCache.drop(baseId);
  }

  /** The cached order book for a base, if subscribed. */
  market(baseId: string): MarketBook | undefined {
    return this.marketCache.book(baseId);
  }

  /**
   * Subscribe to a change-feed of player presence at your current POI/system.
   * Returns the baseline and seeds the observation cache; `observation_update`
   * pushes are merged automatically. Read with `account.observation()`.
   */
  async subscribeObservation(activeScan = false): Promise<SubscribeObservationResponse> {
    const res = await this.query('spacemolt', 'subscribe_observation', activeScan ? { active_scan: true } : undefined);
    const snapshot = res.structuredContent as SubscribeObservationResponse | undefined;
    if (snapshot) this.observationCache.seed(snapshot);
    this.observationSubscribed = true;
    this.observationActiveScan = activeScan;
    return snapshot ?? ({} as SubscribeObservationResponse);
  }

  /** Unsubscribe from the observation watch and clear its cache. */
  async unsubscribeObservation(): Promise<void> {
    this.observationSubscribed = false;
    await this.query('spacemolt', 'unsubscribe_observation');
    this.observationCache.clear();
  }

  /** The current observation watch view, if subscribed. */
  observation(): ObservationView | null {
    return this.observationCache.current();
  }

  /** Close the connection deliberately. Suppresses auto-reconnect. */
  close(): void {
    this.userClosing = true;
    this.socket.close();
  }

  /** Fired after a successful reconnect + re-auth. */
  onReconnected(listener: () => void): void {
    this.reconnectedListener = listener;
  }
  /** Fired at the start of each reconnect attempt (1-based). */
  onReconnecting(listener: (attempt: number) => void): void {
    this.reconnectingListener = listener;
  }
  /** Fired when the connection is gone for good (non-reconnectable or retries exhausted). */
  onDisconnected(listener: (err: ConnectionClosedError) => void): void {
    this.disconnectedListener = listener;
  }

  // --- internals ---

  private async authExchange(
    action: 'login' | 'login_token',
    payload: Record<string, unknown>,
  ): Promise<LoggedInPayload> {
    const state = await new Promise<LoggedInPayload>((resolve, reject) => {
      this.beginAuth(resolve, reject);
      this.sendFrame('spacemolt_auth', action, payload, this.nextRequestId());
    });
    this._loginPayload = state;
    await this.maybeSeedState();
    return state;
  }

  /** Best-effort seed of the state cache after auth; failures are non-fatal. */
  private async maybeSeedState(): Promise<void> {
    if (!this.seedState) return;
    try {
      await this.refresh();
    } catch {
      // The connection is authenticated; a failed seed just leaves the cache
      // to fill from the first mutation delta. Don't fail auth over it.
    }
  }

  private beginAuth(
    onLoggedIn: (state: LoggedInPayload, registered?: RegisteredFrame['payload']) => void,
    onError: (err: SpacemoltError) => void,
  ): void {
    if (this.pendingAuth) {
      onError(new SpacemoltError('auth_in_progress', 'another auth exchange is already in flight'));
      return;
    }
    if (this._authenticated) {
      onError(new SpacemoltError('already_authenticated', 'this connection is already authenticated'));
      return;
    }
    this.pendingAuth = { onLoggedIn, onError };
  }

  private sendFrame(tool: string, action: string, payload: Record<string, unknown> | undefined, requestId: string): void {
    this.socket.send({ tool, action, ...(payload ? { payload } : {}), request_id: requestId });
  }

  private nextRequestId(): string {
    return `r${++this.requestSeq}`;
  }

  private routeFrame(frame: RawFrame): void {
    switch (frame.type) {
      case 'welcome': {
        const payload = (frame as WelcomeFrame).payload;
        this._welcome = payload;
        this.welcomeWaiter?.(payload);
        this.welcomeWaiter = null;
        return;
      }
      case 'registered':
        if (this.pendingAuth) this.pendingAuth.registered = (frame as RegisteredFrame).payload;
        return;
      case 'logged_in': {
        const payload = (frame as LoggedInFrame).payload;
        const auth = this.pendingAuth;
        if (auth) {
          this.pendingAuth = null;
          this._authenticated = true;
          auth.onLoggedIn(payload, auth.registered);
        } else {
          this.emitter.emit(frame);
        }
        return;
      }
      case 'action_result': {
        const delta = (frame as ActionResultFrame).payload.result;
        if (delta) {
          const changed = this.cache.applyDelta(delta);
          if (changed.length) this.stateListener?.(changed);
        }
        if (!this.correlator.handle(frame)) this.emitter.emit(frame);
        return;
      }
      case 'result':
      case 'action_error':
        if (!this.correlator.handle(frame)) this.emitter.emit(frame);
        return;
      case 'error': {
        if (this.correlator.handle(frame)) return;
        const auth = this.pendingAuth;
        if (auth) {
          this.pendingAuth = null;
          auth.onError(errorFromFrame(frame as ErrorFrame));
          return;
        }
        this.emitter.emit(frame);
        return;
      }
      default:
        this.emitter.emit(frame);
    }
  }

  private handleClose(err: ConnectionClosedError): void {
    this._authenticated = false;
    this.correlator.rejectAll(err);
    this.emitter.closeStreams();
    if (this.pendingAuth) {
      const auth = this.pendingAuth;
      this.pendingAuth = null;
      auth.onError(new SpacemoltError('connection_closed', err.message));
    }
    if (this.shouldReconnect(err)) {
      void this.reconnectLoop(err);
    } else if (!this.userClosing) {
      this.disconnectedListener?.(err);
    }
  }

  private shouldReconnect(err: ConnectionClosedError): boolean {
    if (!this.reconnectConfig || this.userClosing || this.reconnecting) return false;
    if (!this.credentialsProvider) return false;
    // 4001 session_replaced: another connection took our slot — reconnecting
    // would just fight it. 4002 auth_timeout: we failed to auth in time.
    if (err.code === 4001 || err.code === 4002) return false;
    return true;
  }

  private async reconnectLoop(err: ConnectionClosedError): Promise<void> {
    if (this.reconnecting || !this.reconnectConfig || !this.credentialsProvider) return;
    this.reconnecting = true;
    const cfg = this.reconnectConfig;
    for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
      this.reconnectingListener?.(attempt);
      const backoff = Math.min(cfg.baseDelayMs * 2 ** (attempt - 1), cfg.maxDelayMs);
      await delay(backoff);
      if (this.userClosing) {
        this.reconnecting = false;
        return;
      }
      try {
        this.makeSocket();
        await this.open();
        await this.authenticate(await this.credentialsProvider());
        await this.resubscribe();
        this.reconnecting = false;
        this.reconnectedListener?.();
        return;
      } catch {
        // try again until retries are exhausted
      }
    }
    this.reconnecting = false;
    this.disconnectedListener?.(err);
  }

  private async resubscribe(): Promise<void> {
    if (this.marketSubscribed) {
      try {
        await this.subscribeMarket();
      } catch {
        /* best-effort */
      }
    }
    if (this.observationSubscribed) {
      try {
        await this.subscribeObservation(this.observationActiveScan);
      } catch {
        /* best-effort */
      }
    }
  }

  private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof SpacemoltError && err.code === 'rate_limited' && attempt < this.maxRateLimitRetries) {
          await delay(retryAfterMs(err));
          continue;
        }
        throw err;
      }
    }
  }

  /** Serialize mutations: each runs only after the previous settles. */
  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationLane.then(task, task);
    this.mutationLane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
