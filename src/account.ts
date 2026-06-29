/**
 * A single authenticated SpaceMolt connection.
 *
 * Owns one WebSocket, performs raw-credential auth, and exposes the
 * query/mutation command API. State caching (M2) and typed push events (M3)
 * layer on top of the `onPush` seam and the resolved deltas here.
 *
 * Auth frames (`registered`, `logged_in`) are handled out-of-band from the
 * `request_id` correlator: after `register` the `logged_in` frame is an
 * unsolicited push with no `request_id`, so auth is sequenced by frame type
 * instead (only one auth exchange is ever in flight on a connection).
 */

import { ACTIONS } from './generated/actions.gen.ts';
import type { V2GameState } from './generated/openapi/types.gen.ts';
import { ConnectionClosedError, errorFromFrame, SpacemoltError } from './errors.ts';
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

export class Account {
  private readonly socket: Socket;
  private readonly correlator = new Correlator();
  private readonly cache = new StateCache();
  private readonly seedState: boolean;
  private requestSeq = 0;

  private _welcome: WelcomeFrame['payload'] | null = null;
  private _authenticated = false;
  private _loginPayload: LoggedInPayload | null = null;
  private welcomeWaiter: ((w: WelcomeFrame['payload']) => void) | null = null;
  private pendingAuth: PendingAuth | null = null;
  private pushListener: ((frame: RawFrame) => void) | null = null;
  private stateListener: ((changed: StateSection[]) => void) | null = null;

  constructor(opts: AccountOptions = {}) {
    this.seedState = opts.seedState ?? true;
    this.socket = new Socket({
      url: opts.url ?? DEFAULT_URL,
      webSocketFactory: opts.webSocketFactory,
    });
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

  /** The server's `welcome` payload, available after `connect()` resolves. */
  get welcome(): WelcomeFrame['payload'] | null {
    return this._welcome;
  }

  get authenticated(): boolean {
    return this._authenticated;
  }

  /** Open the connection and resolve once the `welcome` frame arrives. */
  async connect(): Promise<WelcomeFrame['payload']> {
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

  /** Run a read-only command; resolves synchronously with the result. */
  query(tool: string, action: string, payload?: Record<string, unknown>): Promise<QueryResult> {
    const requestId = this.nextRequestId();
    const promise = this.correlator.awaitQuery(requestId);
    this.sendFrame(tool, action, payload, requestId);
    return promise;
  }

  /**
   * Run a mutation; resolves when the action executes on a later tick (after
   * the immediate pending ack). `onAck` fires when the pending ack arrives.
   */
  mutate(
    tool: string,
    action: string,
    payload?: Record<string, unknown>,
    onAck?: (ack: MutationAck) => void,
  ): Promise<MutationResult> {
    const requestId = this.nextRequestId();
    const promise = this.correlator.awaitMutation(requestId, onAck);
    this.sendFrame(tool, action, payload, requestId);
    return promise;
  }

  /**
   * Run a command, dispatching to `query`/`mutate` based on the spec's
   * `x-is-mutation` classification. Unknown commands are treated as queries.
   */
  send(tool: string, action: string, payload?: Record<string, unknown>): Promise<QueryResult | MutationResult> {
    const def = ACTIONS[`${tool}/${action}`];
    return def?.kind === 'mutation' ? this.mutate(tool, action, payload) : this.query(tool, action, payload);
  }

  /** Register a listener for server push frames (welcome/auth excluded). */
  onPush(listener: (frame: RawFrame) => void): void {
    this.pushListener = listener;
  }

  /** Close the connection. In-flight requests reject with ConnectionClosedError. */
  close(): void {
    this.socket.close();
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
          this.pushListener?.(frame);
        }
        return;
      }
      case 'action_result': {
        const delta = (frame as ActionResultFrame).payload.result;
        if (delta) {
          const changed = this.cache.applyDelta(delta);
          if (changed.length) this.stateListener?.(changed);
        }
        if (!this.correlator.handle(frame)) this.pushListener?.(frame);
        return;
      }
      case 'result':
      case 'action_error':
        if (!this.correlator.handle(frame)) this.pushListener?.(frame);
        return;
      case 'error': {
        if (this.correlator.handle(frame)) return;
        const auth = this.pendingAuth;
        if (auth) {
          this.pendingAuth = null;
          auth.onError(errorFromFrame(frame as ErrorFrame));
          return;
        }
        this.pushListener?.(frame);
        return;
      }
      default:
        this.pushListener?.(frame);
    }
  }

  private handleClose(err: ConnectionClosedError): void {
    this._authenticated = false;
    this.correlator.rejectAll(err);
    if (this.pendingAuth) {
      const auth = this.pendingAuth;
      this.pendingAuth = null;
      auth.onError(new SpacemoltError('connection_closed', err.message));
    }
  }
}
