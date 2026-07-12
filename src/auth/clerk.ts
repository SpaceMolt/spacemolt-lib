/**
 * Clerk-backed multi-account source.
 *
 * Authenticates with a Clerk **API key** (the headless-client credential —
 * generate one from the website; see docs/live-testing.md) to enumerate the
 * player accounts the Clerk user owns and to mint short-lived, single-use
 * WebSocket login tokens for them. This lets one client manage every account you
 * own without storing per-account game passwords.
 *
 * The API key is sent as `Authorization: Bearer <key>` to two gameserver
 * endpoints:
 *   - `GET  /api/registration-code`     → the owned players list.
 *   - `POST /api/player/{id}/ws-token`  → a single-use WS login token.
 *
 * ws-tokens are valid ~5 minutes and consumed on connect, so mint one per
 * (re)connect rather than caching — the durable credential is the Clerk key.
 *
 * Uses only web-standard `fetch`, so it stays browser-safe.
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

export interface ClerkSourceOptions {
  /** Clerk API key, sent as a Bearer token. Keep it secret. */
  apiKey: string;
  /** HTTP origin of the gameserver, e.g. `https://game.spacemolt.com`. */
  httpBaseUrl: string;
  /** Inject a `fetch` implementation (tests, custom runtimes). */
  fetchImpl?: typeof fetch;
}

async function clerkFetch(fetchImpl: typeof fetch, url: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { accept: 'application/json', authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) },
  });
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
export async function mintWsToken(opts: {
  httpBaseUrl: string;
  apiKey: string;
  playerId: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const base = opts.httpBaseUrl.replace(/\/$/, '');
  const data = requireRecord(
    await clerkFetch(
      opts.fetchImpl ?? fetch,
      `${base}/api/player/${encodeURIComponent(opts.playerId)}/ws-token`,
      opts.apiKey,
      { method: 'POST' },
    ),
    'ws-token response',
  );
  if (typeof data.token !== 'string' || !data.token) throw new Error('ws-token response had no token');
  return data.token;
}

export class ClerkSource {
  private readonly fetchImpl: typeof fetch;
  /** HTTP origin of the gameserver (trailing slash stripped). */
  readonly httpBaseUrl: string;

  constructor(private readonly opts: ClerkSourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.httpBaseUrl = opts.httpBaseUrl.replace(/\/$/, '');
  }

  /** The Clerk API key this source authenticates with. */
  get apiKey(): string {
    return this.opts.apiKey;
  }

  /** List the player accounts the authenticated Clerk user owns. */
  async listPlayers(): Promise<ClerkPlayer[]> {
    const data = requireRecord(
      await clerkFetch(this.fetchImpl, `${this.httpBaseUrl}/api/registration-code`, this.opts.apiKey),
      'registration-code response',
    );
    if (!Array.isArray(data.players)) return [];
    return data.players.filter(
      (player): player is ClerkPlayer =>
        isRecord(player) &&
        typeof player.id === 'string' &&
        typeof player.username === 'string' &&
        typeof player.empire === 'string' &&
        typeof player.hidden === 'boolean',
    );
  }

  /** Mint a single-use WS login token for one owned player. */
  mintWsToken(playerId: string): Promise<string> {
    return mintWsToken({
      httpBaseUrl: this.httpBaseUrl,
      apiKey: this.opts.apiKey,
      playerId,
      fetchImpl: this.fetchImpl,
    });
  }
}
