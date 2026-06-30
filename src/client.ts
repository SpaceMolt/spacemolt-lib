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
  /** Delay between connecting accounts in `connectAll`. Default 250ms. */
  connectStaggerMs?: number;
  /**
   * Auto-reconnect each account on an unexpected disconnect, re-authenticating
   * from the stored credentials. Default `true` (the store can supply creds).
   * Token-only accounts can't reconnect (the token is single-use).
   */
  reconnect?: boolean | ReconnectOptions;
  /** HTTP origin for bulk data fetches. Defaults to the origin of `url`. */
  httpBaseUrl?: string;
  /**
   * Clerk API key for `connectOwned()` / `listOwnedPlayers()` — connect every
   * game account the Clerk user owns without storing per-account passwords.
   * Generate one from the website; keep it secret.
   */
  clerkApiKey?: string;
  /** Inject a `fetch` implementation (tests, custom runtimes). */
  fetchImpl?: typeof fetch;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SpacemoltClient {
  private readonly store: CredentialStore;
  private readonly connected = new Map<string, Account>();
  private catalogCache?: CatalogCache;
  private mapCache?: MapCache;
  private clerkSource?: ClerkSource;

  constructor(private readonly opts: SpacemoltClientOptions = {}) {
    this.store = opts.store ?? new MemoryCredentialStore();
  }

  /** HTTP origin used for bulk data fetches (catalog, map). */
  get httpBaseUrl(): string {
    return this.opts.httpBaseUrl ?? (this.opts.url ? httpBaseFromWs(this.opts.url) : DEFAULT_HTTP_BASE);
  }

  /** The bulk catalog, fetched once and cached. Pass `force` to refetch. */
  async catalog(force = false): Promise<CatalogCache> {
    if (force || !this.catalogCache) this.catalogCache = await CatalogCache.load(this.httpBaseUrl);
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
    const stored = await this.store.list();
    return this.connectIds(stored.map((s) => s.id));
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
   */
  async connectOwned(opts: { filter?: (player: ClerkPlayer) => boolean } = {}): Promise<Account[]> {
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
    return this.connectIds(ids);
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

  /** Connect the given stored ids, staggered to respect rate limits. */
  private async connectIds(ids: string[]): Promise<Account[]> {
    const stagger = this.opts.connectStaggerMs ?? 250;
    const accounts: Account[] = [];
    for (let i = 0; i < ids.length; i++) {
      if (i > 0 && stagger > 0) await delay(stagger);
      accounts.push(await this.connect(ids[i]!));
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
      fetchImpl: this.opts.fetchImpl,
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
