#!/usr/bin/env bun

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const GENERATED = join(ROOT, 'src', 'generated');
const COMMANDS = join(ROOT, 'COMMANDS.md');

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function snapshot(): Promise<Map<string, Uint8Array>> {
  const paths = [...(await listFiles(GENERATED)), COMMANDS].sort();
  return new Map(await Promise.all(paths.map(async (path) => [relative(ROOT, path), await readFile(path)] as const)));
}

function equal(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (!left || !right || left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

const before = await snapshot();
const generated = Bun.spawnSync(['bun', 'run', 'generate'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
if (generated.exitCode !== 0) process.exit(generated.exitCode);
const after = await snapshot();

const paths = new Set([...before.keys(), ...after.keys()]);
const changed = [...paths].filter((path) => !equal(before.get(path), after.get(path))).sort();
if (changed.length) {
  console.error(`Generated artifacts were stale:\n${changed.map((path) => `  ${path}`).join('\n')}`);
  console.error('The files have been regenerated; review and commit the changes.');
  process.exit(1);
}

console.log(`generate:check: ${after.size} generated artifacts are current`);
