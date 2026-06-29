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
import { ConnectionClosedError, errorFromFrame, SpacemoltError } from './errors.ts';
import type {
  ErrorFrame,
  LoggedInFrame,
  MutationAck,
  MutationResult,
  QueryResult,
  RawFrame,
  RegisteredFrame,
  WelcomeFrame,
} from './protocol.ts';
import { Correlator } from './transport/correlator.ts';
import { Socket, type WebSocketFactory } from './transport/socket.ts';

export type LoggedInPayload = Record<string, unknown>;

export interface AccountOptions {
  /** WebSocket URL of the v2 endpoint. Defaults to the production server. */
  url?: string;
  /** Inject a WebSocket implementation (tests, custom runtimes). */
  webSocketFactory?: WebSocketFactory;
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
  private requestSeq = 0;

  private _welcome: WelcomeFrame['payload'] | null = null;
  private _authenticated = false;
  private welcomeWaiter: ((w: WelcomeFrame['payload']) => void) | null = null;
  private pendingAuth: PendingAuth | null = null;
  private pushListener: ((frame: RawFrame) => void) | null = null;

  constructor(opts: AccountOptions = {}) {
    this.socket = new Socket({
      url: opts.url ?? DEFAULT_URL,
      webSocketFactory: opts.webSocketFactory,
    });
    this.socket.onFrame = (frame) => this.routeFrame(frame);
    this.socket.onClose = (err) => this.handleClose(err);
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
  register(params: RegisterParams): Promise<RegisterResult> {
    return new Promise<RegisterResult>((resolve, reject) => {
      this.beginAuth((state, registered) => {
        if (!registered) {
          reject(new SpacemoltError('missing_credentials', 'register succeeded but no credentials frame was received'));
          return;
        }
        resolve({ password: registered.password, player_id: registered.player_id, state });
      }, reject);
      this.sendFrame('spacemolt_auth', 'register', { ...params }, this.nextRequestId());
    });
  }

  /** Authenticate an existing account with username + password. */
  login(params: { username: string; password: string }): Promise<LoggedInPayload> {
    return this.authExchange('login', { ...params });
  }

  /** Authenticate with a short-lived single-use token (web/Clerk path). */
  loginToken(token: string): Promise<LoggedInPayload> {
    return this.authExchange('login_token', { token });
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

  private authExchange(action: 'login' | 'login_token', payload: Record<string, unknown>): Promise<LoggedInPayload> {
    return new Promise<LoggedInPayload>((resolve, reject) => {
      this.beginAuth(resolve, reject);
      this.sendFrame('spacemolt_auth', action, payload, this.nextRequestId());
    });
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
      case 'result':
      case 'action_result':
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
