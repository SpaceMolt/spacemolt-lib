/**
 * Pluggable credential storage for multi-account use.
 *
 * The `CredentialStore` interface is the only persistence seam in the library;
 * swap the implementation to control where credentials live (memory, a file,
 * the browser, a secrets manager, …). The core never imports Node built-ins —
 * the file-backed store does, and lives here in `src/auth/` for that reason.
 */

import { isRecord } from '../validation.ts';

/**
 * How an account authenticates. Raw credentials (login / login_token / register)
 * plus `clerk`: a Clerk API key + the owned player's id, from which the account
 * mints a fresh single-use WS token on each (re)connect (see `src/auth/clerk.ts`).
 */
export type AuthCredentials =
  | { kind: 'login'; username: string; password: string }
  | { kind: 'login_token'; token: string }
  | { kind: 'clerk'; apiKey: string; playerId: string; httpBaseUrl: string }
  | { kind: 'register'; username: string; empire: string; registration_code?: string };

export interface StoredAccount {
  /** Stable handle for this account within the client (e.g. the username). */
  id: string;
  credentials: AuthCredentials;
  /** Filled in after a successful auth. */
  playerId?: string;
}

export interface CredentialStore {
  list(): Promise<StoredAccount[]>;
  get(id: string): Promise<StoredAccount | undefined>;
  put(account: StoredAccount): Promise<void>;
  remove(id: string): Promise<void>;
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

export function isStoredAccount(value: unknown): value is StoredAccount {
  if (!isRecord(value) || !hasString(value, 'id') || !isRecord(value.credentials)) return false;
  const credentials = value.credentials;
  switch (credentials.kind) {
    case 'login':
      return hasString(credentials, 'username') && hasString(credentials, 'password');
    case 'login_token':
      return hasString(credentials, 'token');
    case 'clerk':
      return (
        hasString(credentials, 'apiKey') && hasString(credentials, 'playerId') && hasString(credentials, 'httpBaseUrl')
      );
    case 'register':
      return (
        hasString(credentials, 'username') &&
        hasString(credentials, 'empire') &&
        (credentials.registration_code === undefined || typeof credentials.registration_code === 'string')
      );
    default:
      return false;
  }
}

/** In-memory store. The default; nothing is persisted across process restarts. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly accounts = new Map<string, StoredAccount>();

  list(): Promise<StoredAccount[]> {
    return Promise.resolve([...this.accounts.values()]);
  }
  get(id: string): Promise<StoredAccount | undefined> {
    return Promise.resolve(this.accounts.get(id));
  }
  put(account: StoredAccount): Promise<void> {
    this.accounts.set(account.id, account);
    return Promise.resolve();
  }
  remove(id: string): Promise<void> {
    this.accounts.delete(id);
    return Promise.resolve();
  }
}
