/**
 * Clerk-backed multi-account source.
 *
 * Authenticates against the Clerk-gated gameserver endpoints to enumerate the
 * player accounts the Clerk user owns and to mint short-lived, single-use
 * WebSocket login tokens for them. This lets one client manage every account you
 * own without storing per-account game passwords.
 *
 * Two ways to authorize the requests:
 *   - `apiKey` — a Clerk **API key** (the headless-client credential —
 *     generate one from the website; see docs/live-testing.md), sent as
 *     `Authorization: Bearer <key>`.
 *   - `headers` — custom headers, or an async factory resolved fresh per
 *     request, for callers whose credential isn't a static key: a browser
 *     Clerk session's short-lived `getToken()` JWT, or a dev-mode
 *     `X-Dev-Clerk-ID` header.
 *
 * The authorized endpoints:
 *   - `GET  /api/registration-code`     → the owned players list + registration code.
 *   - `POST /api/player/{id}/ws-token`  → a single-use WS login token.
 *
 * ws-tokens are valid ~5 minutes and consumed on connect, so mint one per
 * (re)connect rather than caching — the durable credential is the Clerk key
 * (or session).
 *
 * Uses only web-standard `fetch`/`Headers`, so it stays browser-safe.
 */

import { isRecord, requireRecord } from '../validation.ts';

/** A player account owned by the authenticated Clerk user. */
export interface ClerkPlayer {
  id: string;
  username: string;
  empire: string;
  /** Hidden in the player's dashboard; still connectable. */
  hidden: boolean;
}

/** The full `/api/registration-code` response. */
export interface ClerkRegistration {
  /** One-time code that links a new `register` to the Clerk user. */
  registrationCode: string;
  players: ClerkPlayer[];
}

/**
 * Headers that authorize calls to the Clerk-gated gameserver endpoints — an
 * alternative to `apiKey` for callers whose credential isn't a static key.
 * A factory is resolved fresh on every request, so short-lived tokens (e.g. a
 * browser Clerk session's `getToken()` JWT) stay valid across reconnects.
 */
export type ClerkAuthHeaders = HeadersInit | (() => HeadersInit | Promise<HeadersInit>);

/** How Clerk-gated requests are authorized. Provide `apiKey`, `headers`, or both. */
export interface ClerkAuth {
  /** Clerk API key, sent as `Authorization: Bearer`. Keep it secret. */
  apiKey?: string;
  /** Custom auth headers (or an async factory). Win over `apiKey` on conflicts. */
  headers?: ClerkAuthHeaders;
}

async function resolveAuthHeaders(auth: ClerkAuth): Promise<Headers> {
  if (auth.apiKey === undefined && auth.headers === undefined) {
    throw new Error('Clerk auth requires an `apiKey` or `headers`');
  }
  const headers = new Headers(auth.apiKey === undefined ? undefined : { authorization: `Bearer ${auth.apiKey}` });
  const extra = typeof auth.headers === 'function' ? await auth.headers() : auth.headers;
  new Headers(extra).forEach((value, key) => {
    headers.set(key, value);
  });
  return headers;
}

async function clerkFetch(fetchImpl: typeof fetch, url: string, auth: ClerkAuth, init?: RequestInit): Promise<unknown> {
  const headers = new Headers({ accept: 'application/json' });
  (await resolveAuthHeaders(auth)).forEach((value, key) => {
    headers.set(key, value);
  });
  new Headers(init?.headers).forEach((value, key) => {
    headers.set(key, value);
  });
  const res = await fetchImpl(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return res.json();
}

/**
 * Mint a single-use WebSocket login token for one owned player. The token is
 * valid ~5 minutes and consumed on connect, so call this once per (re)connect.
 */
export async function mintWsToken(
  opts: {
    httpBaseUrl: string;
    playerId: string;
    fetchImpl?: typeof fetch;
  } & ClerkAuth,
): Promise<string> {
  const base = opts.httpBaseUrl.replace(/\/$/, '');
  const data = requireRecord(
    await clerkFetch(
      opts.fetchImpl ?? fetch,
      `${base}/api/player/${encodeURIComponent(opts.playerId)}/ws-token`,
      opts,
      {
        method: 'POST',
      },
    ),
    'ws-token response',
  );
  if (typeof data.token !== 'string' || !data.token) throw new Error('ws-token response had no token');
  return data.token;
}

export interface ClerkSourceOptions extends ClerkAuth {
  /** HTTP origin of the gameserver, e.g. `https://game.spacemolt.com`. */
  httpBaseUrl: string;
  /** Inject a `fetch` implementation (tests, custom runtimes). */
  fetchImpl?: typeof fetch;
}

export class ClerkSource {
  private readonly fetchImpl: typeof fetch;
  /** HTTP origin of the gameserver (trailing slash stripped). */
  readonly httpBaseUrl: string;

  constructor(private readonly opts: ClerkSourceOptions) {
    if (opts.apiKey === undefined && opts.headers === undefined) {
      throw new Error('ClerkSource requires an `apiKey` or `headers`');
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.httpBaseUrl = opts.httpBaseUrl.replace(/\/$/, '');
  }

  /** The Clerk API key this source authenticates with, when one was given. */
  get apiKey(): string | undefined {
    return this.opts.apiKey;
  }

  /** Fetch the owned players list plus the registration code for creating new players. */
  async fetchRegistration(): Promise<ClerkRegistration> {
    const data = requireRecord(
      await clerkFetch(this.fetchImpl, `${this.httpBaseUrl}/api/registration-code`, this.opts),
      'registration-code response',
    );
    const players = Array.isArray(data.players)
      ? data.players.filter(
          (player): player is ClerkPlayer =>
            isRecord(player) &&
            typeof player.id === 'string' &&
            typeof player.username === 'string' &&
            typeof player.empire === 'string' &&
            typeof player.hidden === 'boolean',
        )
      : [];
    return {
      registrationCode: typeof data.registration_code === 'string' ? data.registration_code : '',
      players,
    };
  }

  /** List the player accounts the authenticated Clerk user owns. */
  async listPlayers(): Promise<ClerkPlayer[]> {
    return (await this.fetchRegistration()).players;
  }

  /** Mint a single-use WS login token for one owned player. */
  mintWsToken(playerId: string): Promise<string> {
    return mintWsToken({
      httpBaseUrl: this.httpBaseUrl,
      apiKey: this.opts.apiKey,
      headers: this.opts.headers,
      playerId,
      fetchImpl: this.fetchImpl,
    });
  }
}
