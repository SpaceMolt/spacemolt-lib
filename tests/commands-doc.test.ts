import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractActions, emitCommandsDoc } from '../scripts/generate.ts';
import { ACTIONS } from '../src/generated/actions.gen.ts';

const ROOT = join(import.meta.dir, '..');

// COMMANDS.md is the agent-facing discovery surface and is generated from the
// same spec as src/generated/. Guard it the way the generated TS is guarded:
// if it drifts from the committed spec, the sync would ship a stale reference.
test('COMMANDS.md is in sync with the committed spec (run `bun run generate`)', () => {
  const spec = JSON.parse(readFileSync(join(ROOT, 'openapi.json'), 'utf-8'));
  const expected = emitCommandsDoc(spec, extractActions(spec));
  const committed = readFileSync(join(ROOT, 'COMMANDS.md'), 'utf-8');
  expect(committed).toBe(expected);
});

test('COMMANDS.md documents every command in the catalog', () => {
  const doc = readFileSync(join(ROOT, 'COMMANDS.md'), 'utf-8');
  for (const def of Object.values(ACTIONS)) {
    // Each command appears under its tool section as `<action>(` ... .
    expect(doc).toContain(`## ${def.tool}\n`);
    expect(doc).toContain(`\`${def.action}(`);
  }
});
