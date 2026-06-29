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

import { writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const BASE = (process.argv[2] ?? process.env.SPACEMOLT_URL ?? 'https://game.spacemolt.com').replace(/\/$/, '');

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const specUrl = `${BASE}/api/v2/openapi.json`;
  console.log(`fetching ${specUrl}`);
  const spec = (await fetchJson(specUrl)) as { openapi?: string; paths?: Record<string, unknown> };

  if (!spec.openapi || !spec.paths || !Object.keys(spec.paths).some((p) => p.startsWith('/api/v2/'))) {
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
