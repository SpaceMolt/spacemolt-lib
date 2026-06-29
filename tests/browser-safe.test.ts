import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

// The Node-only seam — these are allowed to import Node built-ins and must NOT
// be reachable from the main entry point.
const NODE_ONLY = new Set(['auth/file-store.ts', 'node.ts']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('core source imports no Node built-ins (browser-safe)', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).replaceAll('\\', '/');
    if (NODE_ONLY.has(rel)) continue;
    const src = readFileSync(file, 'utf-8');
    if (/from\s+['"]node:/.test(src) || /\brequire\s*\(/.test(src)) {
      offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
