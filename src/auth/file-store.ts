/**
 * File-backed credential store (Node / Bun).
 *
 * Persists accounts as JSON. Credentials are stored in plaintext — the same
 * tradeoff the CLI makes — so point it at a path your environment protects.
 * Imports Node built-ins; do not import this from browser bundles (use a
 * custom `CredentialStore` there instead).
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CredentialStore, StoredAccount } from './credentials.ts';

interface FileShape {
  version: 1;
  accounts: Record<string, StoredAccount>;
}

export class FileCredentialStore implements CredentialStore {
  private cache: Record<string, StoredAccount> | null = null;

  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, StoredAccount>> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as FileShape;
      this.cache = parsed.accounts ?? {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    const data: FileShape = { version: 1, accounts: this.cache ?? {} };
    await mkdir(dirname(this.path), { recursive: true });
    // Atomic write: temp file + rename, so a crash can't truncate the store.
    const tmp = `${this.path}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.path);
  }

  async list(): Promise<StoredAccount[]> {
    return Object.values(await this.load());
  }
  async get(id: string): Promise<StoredAccount | undefined> {
    return (await this.load())[id];
  }
  async put(account: StoredAccount): Promise<void> {
    const accounts = await this.load();
    accounts[account.id] = account;
    await this.save();
  }
  async remove(id: string): Promise<void> {
    const accounts = await this.load();
    delete accounts[id];
    await this.save();
  }
}
