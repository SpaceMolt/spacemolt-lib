#!/usr/bin/env bun
/**
 * Syncs the committed OpenAPI spec (and catalog dump) from the live server.
 *
 * Writes to a staging file first, validates it looks like a v2 spec, then
 * atomically replaces openapi.json. After running this, run `bun run generate`
 * to regenerate the library internals, then `bun run typecheck`.
 *
 *   bun run scripts/fetch-spec.ts [baseUrl]
 *
 * Default base URL: https://game.spacemolt.com
 */

import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../src/validation.ts';

const ROOT = join(import.meta.dir, '..');
const BASE = (process.argv[2] ?? process.env.SPACEMOLT_URL ?? 'https://game.spacemolt.com').replace(/\/$/, '');

// The spec endpoint rate-limits fetches (1/min per IP) with a 429 — e.g. when
// sync-spec's version probe hit the URL seconds earlier. Treat 429 (and other
// transient statuses) as retryable with a backoff that clears the window,
// mirroring client-v2's `curl --retry 4 --retry-delay 40`.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 40_000;
const MAX_ATTEMPTS = 5;

async function fetchJson(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (res.ok) return res.json();
    if (attempt >= MAX_ATTEMPTS || !RETRYABLE.has(res.status)) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    console.log(
      `GET ${url} -> ${res.status} ${res.statusText}; retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`,
    );
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
}

async function main() {
  const specUrl = `${BASE}/api/v2/openapi.json`;
  console.log(`fetching ${specUrl}`);
  const spec = await fetchJson(specUrl);

  if (
    !isRecord(spec) ||
    typeof spec.openapi !== 'string' ||
    !isRecord(spec.paths) ||
    !Object.keys(spec.paths).some((path) => path.startsWith('/api/v2/'))
  ) {
    throw new Error('fetched document does not look like the v2 OpenAPI spec');
  }

  const staging = join(ROOT, 'openapi.staging.json');
  writeFileSync(staging, JSON.stringify(spec, null, 2));
  renameSync(staging, join(ROOT, 'openapi.json'));
  console.log(`wrote openapi.json (${Object.keys(spec.paths).length} paths). Next: bun run generate`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
