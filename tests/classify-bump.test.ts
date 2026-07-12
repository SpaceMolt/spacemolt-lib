import { expect, test } from 'bun:test';
import { classifyCatalog, classifyCommits, nextVersion, maxLevel } from '../scripts/classify-bump.ts';
import type { OpenAPISpec } from '../scripts/generate.ts';

// Build a minimal openapi.json-shaped spec from a compact action description.
interface A {
  tool: string;
  action: string;
  mutation?: boolean;
  props?: Record<string, { type?: string; enum?: string[] }>;
  required?: string[];
}
function spec(actions: A[], notifs: string[] = []): OpenAPISpec {
  const paths: OpenAPISpec['paths'] = {};
  for (const a of actions) {
    paths[`/api/v2/${a.tool}/${a.action}`] = {
      post: {
        'x-is-mutation': a.mutation ?? false,
        requestBody: {
          content: { 'application/json': { schema: { properties: a.props ?? {}, required: a.required ?? [] } } },
        },
      },
    };
  }
  const schemas: Record<string, unknown> = {};
  for (const n of notifs) schemas[`Notification_${n}`] = { type: 'object' };
  return { info: { version: '1', 'x-gameserver-version': 'vTest' }, paths, components: { schemas } };
}

test('maxLevel orders severities', () => {
  expect(maxLevel('none', 'patch')).toBe('patch');
  expect(maxLevel('minor', 'major')).toBe('major');
  expect(maxLevel('major', 'patch')).toBe('major');
});

test('nextVersion applies true semver (major = break)', () => {
  expect(nextVersion('1.4.2', 'major')).toBe('2.0.0');
  expect(nextVersion('1.4.2', 'minor')).toBe('1.5.0');
  expect(nextVersion('1.4.2', 'patch')).toBe('1.4.3');
  expect(nextVersion('1.4.2', 'none')).toBe('1.4.2');
});

test('removed command is major; added command is minor', () => {
  const oldS = spec([
    { tool: 'spacemolt', action: 'jump' },
    { tool: 'spacemolt', action: 'mine' },
  ]);
  const newS = spec([
    { tool: 'spacemolt', action: 'jump' },
    { tool: 'spacemolt', action: 'scan' },
  ]);
  const { level, reasons } = classifyCatalog(oldS, newS);
  expect(level).toBe('major');
  expect(reasons.some((r) => r.includes('command removed: spacemolt/mine'))).toBe(true);
  expect(reasons.some((r) => r.includes('command added: spacemolt/scan'))).toBe(true);
});

test('query<->mutation kind flip is major', () => {
  const oldS = spec([{ tool: 'spacemolt', action: 'scan', mutation: false }]);
  const newS = spec([{ tool: 'spacemolt', action: 'scan', mutation: true }]);
  expect(classifyCatalog(oldS, newS).level).toBe('major');
});

test('new required param is major; new optional param is minor', () => {
  const base = { tool: 'spacemolt', action: 'jump', props: { id: { type: 'string' } }, required: ['id'] };
  const reqAdded = spec([
    { ...base, props: { id: { type: 'string' }, gate: { type: 'string' } }, required: ['id', 'gate'] },
  ]);
  const optAdded = spec([{ ...base, props: { id: { type: 'string' }, fast: { type: 'boolean' } }, required: ['id'] }]);
  expect(classifyCatalog(spec([base]), reqAdded).level).toBe('major');
  expect(classifyCatalog(spec([base]), optAdded).level).toBe('minor');
});

test('param removed and optional->required are major', () => {
  const oldS = spec([
    { tool: 'spacemolt', action: 'buy', props: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] },
  ]);
  const removed = spec([{ tool: 'spacemolt', action: 'buy', props: { id: { type: 'string' } }, required: ['id'] }]);
  const required = spec([
    {
      tool: 'spacemolt',
      action: 'buy',
      props: { id: { type: 'string' }, note: { type: 'string' } },
      required: ['id', 'note'],
    },
  ]);
  expect(classifyCatalog(oldS, removed).level).toBe('major');
  expect(classifyCatalog(oldS, required).level).toBe('major');
});

test('enum value removed is major; added is minor', () => {
  const oldS = spec([{ tool: 'm', action: 'order', props: { side: { type: 'string', enum: ['buy', 'sell'] } } }]);
  const removed = spec([{ tool: 'm', action: 'order', props: { side: { type: 'string', enum: ['buy'] } } }]);
  const added = spec([
    { tool: 'm', action: 'order', props: { side: { type: 'string', enum: ['buy', 'sell', 'short'] } } },
  ]);
  expect(classifyCatalog(oldS, removed).level).toBe('major');
  expect(classifyCatalog(oldS, added).level).toBe('minor');
});

test('notification type removed is major; added is minor', () => {
  const oldS = spec([], ['chat_message', 'mining_yield']);
  const removed = spec([], ['chat_message']);
  const added = spec([], ['chat_message', 'mining_yield', 'beacon_ping']);
  expect(classifyCatalog(oldS, removed).level).toBe('major');
  expect(classifyCatalog(oldS, added).level).toBe('minor');
});

test('identical surface is no bump', () => {
  const s = spec(
    [{ tool: 'spacemolt', action: 'jump', props: { id: { type: 'string' } }, required: ['id'] }],
    ['chat_message'],
  );
  expect(classifyCatalog(s, structuredClone(s)).level).toBe('none');
});

test('conventional commits classify by type', () => {
  expect(classifyCommits(['feat: add fleet command']).level).toBe('minor');
  expect(classifyCommits(['fix: correct retry parsing']).level).toBe('patch');
  expect(classifyCommits(['chore: bump deps', 'docs: tweak readme']).level).toBe('none');
  expect(classifyCommits(['feat!: rename connect to connectAll']).level).toBe('major');
  expect(classifyCommits(['refactor: internals\n\nBREAKING CHANGE: dropped Account.foo']).level).toBe('major');
});

test('bump is the max across commits', () => {
  const msgs = ['docs: x', 'fix: y', 'feat: z'];
  expect(classifyCommits(msgs).level).toBe('minor');
});
