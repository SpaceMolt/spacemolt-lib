#!/usr/bin/env bun
/**
 * Rewrites `.ts` import/export specifiers to `.js` in the emitted .d.ts files.
 *
 * The source uses explicit `.ts` extensions (Bun/`allowImportingTsExtensions`),
 * but the published declarations must point at the `.js` the bundle ships, so
 * they resolve for downstream consumers. tsc's `rewriteRelativeImportExtensions`
 * does not cover declaration-only emit here, so we post-process.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

const DIST = join(import.meta.dir, '..', 'dist');
const SPECIFIER = /(from\s+['"])(\.\.?\/[^'"]+)\.ts(['"])/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(DIST)) {
  const src = readFileSync(file, 'utf-8');
  const next = src.replace(SPECIFIER, '$1$2.js$3');
  if (next !== src) {
    writeFileSync(file, next);
    changed++;
  }
}
console.log(`fix-dts-extensions: rewrote ${changed} declaration file(s)`);
