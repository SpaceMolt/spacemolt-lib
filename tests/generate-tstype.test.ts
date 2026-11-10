import { expect, test } from 'bun:test';
import { tsType } from '../scripts/generate.ts';

// get_action_log event_type is published as `type: ["string","array"]` (one
// event type or several). A type list is a union; collapsing it to `string`
// rejected the array form the server accepts.
test('tsType maps a JSON Schema type list to a union', () => {
  expect(tsType({ type: ['string', 'array'], items: { type: 'string' } })).toBe('string | string[]');
  expect(tsType({ type: ['integer', 'number'] })).toBe('number');
});
