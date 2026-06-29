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

export interface SpacemoltClientOptions {
  /** WebSocket URL of the v2 endpoint. */
  url?: string;
  /** Where credentials live. Defaults to an in-memory store. */
  store?: CredentialStore;
  /** Inject a WebSocket implementation (tests, custom runtimes). */
  webSocketFactory?: WebSocketFactory;
  /** Seed each account's state cache after auth (see Account). Default true. */
  seedState?: boolean;
  /** Delay between connecting accounts in `connectAll`. Default 250ms. */
  connectStaggerMs?: number;
  /**
   * Auto-reconnect each account on an unexpected disconnect, re-authenticating
   * from the stored credentials. Default `true` (the store can supply creds).
   * Token-only accounts can't reconnect (the token is single-use).
   */
  reconnect?: boolean | ReconnectOptions;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SpacemoltClient {
  private readonly store: CredentialStore;
  private readonly connected = new Map<string, Account>();

  constructor(private readonly opts: SpacemoltClientOptions = {}) {
    this.store = opts.store ?? new MemoryCredentialStore();
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
    await account.connect();
    const result = await account.register(params);
    await this.store.put({
      id: params.username,
      credentials: { kind: 'login', username: params.username, password: result.password },
      playerId: result.player_id,
    });
    return { account, result };
  }

  /** Connect and authenticate one stored account. Idempotent per id. */
  async connect(id: string): Promise<Account> {
    const existing = this.connected.get(id);
    if (existing) return existing;
    const stored = await this.store.get(id);
    if (!stored) throw new Error(`no stored credentials for account "${id}"`);
    const account = this.createAccount(id);
    this.connected.set(id, account);
    try {
      await account.connect();
      await account.authenticate(stored.credentials);
    } catch (err) {
      this.connected.delete(id);
      account.close();
      throw err;
    }
    await this.capturePlayerId(stored);
    return account;
  }

  /** Connect every stored account, staggered to respect rate limits. */
  async connectAll(): Promise<Account[]> {
    const stagger = this.opts.connectStaggerMs ?? 250;
    const stored = await this.store.list();
    const accounts: Account[] = [];
    for (let i = 0; i < stored.length; i++) {
      if (i > 0 && stagger > 0) await delay(stagger);
      accounts.push(await this.connect(stored[i]!.id));
    }
    return accounts;
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

  private createAccount(id: string): Account {
    return new Account({
      url: this.opts.url,
      webSocketFactory: this.opts.webSocketFactory,
      seedState: this.opts.seedState,
      reconnect: this.opts.reconnect ?? true,
      credentials: async () => {
        const stored = await this.store.get(id);
        if (!stored) throw new Error(`no stored credentials for account "${id}"`);
        return stored.credentials;
      },
    });
  }

  private async capturePlayerId(stored: StoredAccount): Promise<void> {
    const playerId = this.connected.get(stored.id)?.player?.id;
    if (playerId && playerId !== stored.playerId) {
      await this.store.put({ ...stored, playerId });
    }
  }
}

export type { AuthCredentials, CredentialStore, StoredAccount };
