#!/usr/bin/env bun
/**
 * Programmatic semver bump classifier.
 *
 * True semver, honest about breakage: **major = we broke a consumer's code.**
 * There is no "0.x means unstable" hedge — the major number is allowed (expected)
 * to climb fast, because a self-maintaining lib whose command surface tracks a
 * live server breaks things regularly, and a high major IS the stability signal.
 *
 * The bump is `max(catalog-diff, commit-signal)`:
 *
 *  - **catalog diff** — compares the generated command/notification surface at
 *    the last release tag against the current spec. This is fully deterministic
 *    (the surface is structured data we own) and is what classifies the
 *    automated spec syncs that land without human review.
 *  - **commit signal** — conventional commits since the last tag, for changes to
 *    the hand-written layer the spec can't see (feat! / BREAKING CHANGE → major,
 *    feat → minor, fix / perf → patch).
 *
 * Prints JSON: { current, next, level, reasons[], specVersion }. The release
 * workflow reads `next` and `level`.
 *
 *   bun run scripts/classify-bump.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { extractActions, type ActionDef } from './generate.ts';

const ROOT = join(import.meta.dir, '..');

export type Level = 'none' | 'patch' | 'minor' | 'major';
const ORDER: Record<Level, number> = { none: 0, patch: 1, minor: 2, major: 3 };
export const maxLevel = (a: Level, b: Level): Level => (ORDER[a] >= ORDER[b] ? a : b);

export interface Classification {
  level: Level;
  reasons: string[];
}

interface Spec {
  info: { version: string; 'x-gameserver-version'?: string };
  paths: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown> };
}

/** Classify the difference between two generated command/notification surfaces. */
export function classifyCatalog(oldSpec: Spec, newSpec: Spec): Classification {
  const reasons: string[] = [];
  let level: Level = 'none';
  const bump = (l: Level, reason: string) => {
    level = maxLevel(level, l);
    reasons.push(`${l}: ${reason}`);
  };

  const index = (defs: ActionDef[]) => new Map(defs.map((d) => [`${d.tool}/${d.action}`, d]));
  // extractActions reads spec.paths; both specs are the committed openapi.json shape.
  const oldA = index(extractActions(oldSpec as never));
  const newA = index(extractActions(newSpec as never));

  for (const key of oldA.keys()) if (!newA.has(key)) bump('major', `command removed: ${key}`);
  for (const key of newA.keys()) if (!oldA.has(key)) bump('minor', `command added: ${key}`);

  for (const [key, o] of oldA) {
    const n = newA.get(key);
    if (!n) continue;
    if (o.kind !== n.kind) bump('major', `${key} changed ${o.kind} -> ${n.kind} (alters await semantics)`);

    const oP = new Map(o.params.map((p) => [p.name, p]));
    const nP = new Map(n.params.map((p) => [p.name, p]));
    for (const [pn, op] of oP) {
      const np = nP.get(pn);
      if (!np) {
        bump('major', `${key}: param removed: ${pn}`);
        continue;
      }
      if (!op.required && np.required) bump('major', `${key}: param now required: ${pn}`);
      if (op.type !== np.type) {
        const oe = op.enumValues ?? [];
        const ne = np.enumValues ?? [];
        if (oe.length && ne.length) {
          const removed = oe.filter((v) => !ne.includes(v));
          const added = ne.filter((v) => !oe.includes(v));
          if (removed.length) bump('major', `${key}: enum value(s) removed from ${pn}: ${removed.join(', ')}`);
          else if (added.length) bump('minor', `${key}: enum value(s) added to ${pn}: ${added.join(', ')}`);
        } else {
          // Conservative: a non-enum type change is treated as breaking.
          bump('major', `${key}: param type changed: ${pn} (${op.type} -> ${np.type})`);
        }
      }
    }
    for (const [pn, np] of nP) {
      if (!oP.has(pn)) bump(np.required ? 'major' : 'minor', `${key}: param added${np.required ? ' (required)' : ''}: ${pn}`);
    }
  }

  const notif = (s: Spec) =>
    new Set(Object.keys(s.components?.schemas ?? {}).filter((nm) => nm.startsWith('Notification_')));
  const oldN = notif(oldSpec);
  const newN = notif(newSpec);
  const strip = (nm: string) => nm.slice('Notification_'.length);
  for (const nm of oldN) if (!newN.has(nm)) bump('major', `notification type removed: ${strip(nm)}`);
  for (const nm of newN) if (!oldN.has(nm)) bump('minor', `notification type added: ${strip(nm)}`);

  return { level, reasons };
}

/** Classify conventional-commit messages (full bodies) since the last release. */
export function classifyCommits(messages: string[]): Classification {
  const reasons: string[] = [];
  let level: Level = 'none';
  const bump = (l: Level, reason: string) => {
    level = maxLevel(level, l);
    reasons.push(`${l}: ${reason}`);
  };

  for (const msg of messages) {
    const subject = (msg.split('\n')[0] ?? '').trim();
    const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:/);
    const breaking = (m && m[3] === '!') || /\bBREAKING[ -]CHANGE\b/.test(msg);
    if (breaking) {
      bump('major', `breaking commit: ${subject}`);
      continue;
    }
    if (!m) continue;
    const type = m[1];
    if (type === 'feat') bump('minor', `feat: ${subject}`);
    else if (type === 'fix' || type === 'perf') bump('patch', `${type}: ${subject}`);
    // chore / docs / ci / refactor / test / style / build -> no bump
  }

  return { level, reasons };
}

/** Apply a bump level to a semver string. */
export function nextVersion(current: string, level: Level): string {
  const [maj = 0, min = 0, pat = 0] = current.split('.').map(Number);
  switch (level) {
    case 'major':
      return `${maj + 1}.0.0`;
    case 'minor':
      return `${maj}.${min + 1}.0`;
    case 'patch':
      return `${maj}.${min}.${pat + 1}`;
    default:
      return current;
  }
}

function git(args: string): string {
  // Capture stderr (don't inherit) so a non-fatal `git describe` miss stays quiet.
  // maxBuffer well above the committed openapi.json size (~2MB): the default 1MB
  // would make `git show <tag>:openapi.json` throw, silently skipping the catalog
  // diff — which is exactly the half that detects breaking (major) spec changes.
  return execSync(`git ${args}`, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function lastReleaseTag(): string | null {
  try {
    return git('describe --tags --abbrev=0 --match "v*"') || null;
  } catch {
    return null; // no tags yet
  }
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const newSpec: Spec = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf-8'));
  const specVersion = newSpec.info?.['x-gameserver-version'] ?? newSpec.info?.version;
  const tag = lastReleaseTag();

  if (!tag) {
    // First release: ship the seeded package.json version as-is (1.0.0).
    console.log(
      JSON.stringify(
        { current: pkg.version, next: pkg.version, level: 'initial', reasons: ['no prior tag — initial release'], specVersion },
        null,
        2,
      ),
    );
    return;
  }

  const base = tag.replace(/^v/, '');
  let cat: Classification = { level: 'none', reasons: [] };
  try {
    const oldSpec: Spec = JSON.parse(git(`show ${tag}:openapi.json`));
    cat = classifyCatalog(oldSpec, newSpec);
  } catch (err) {
    // Surface WHY the diff was skipped — a silent skip once hid the catalog diff
    // never running at all (default execSync maxBuffer vs a ~2MB spec).
    cat = { level: 'none', reasons: [`(catalog diff skipped: ${(err as Error).message.split('\n')[0]})`] };
  }

  const raw = git(`log ${tag}..HEAD --format=%B%x00`);
  const messages = raw.split('\u0000').map((s) => s.trim()).filter(Boolean);
  const com = classifyCommits(messages);

  const level = maxLevel(cat.level, com.level);
  const next = nextVersion(base, level);
  console.log(
    JSON.stringify({ current: base, next, level, reasons: [...cat.reasons, ...com.reasons], specVersion }, null, 2),
  );
}

if (import.meta.main) main();
