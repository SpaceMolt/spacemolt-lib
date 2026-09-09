import { describe, expect, test } from 'bun:test';
import type { OrderLevel } from '../src/generated/openapi/types.gen.ts';
import { walkBook } from '../src/data/order-book.ts';

/** Real depth from frontier_station fuel cells: 12 levels, 993 units total. */
const bids: OrderLevel[] = [
  { price_each: 3119, quantity: 126 },
  { price_each: 3103, quantity: 56 },
  { price_each: 3084, quantity: 17 },
];

describe('walkBook', () => {
  test('fills within the top level at the top price', () => {
    expect(walkBook(bids, 100)).toEqual({ filled: 100, gross: 311_900, average: 3119, unfilled: 0 });
  });

  test('eats through levels, so the average drops below the best price', () => {
    const walk = walkBook(bids, 150);
    expect(walk.filled).toBe(150);
    expect(walk.gross).toBe(126 * 3119 + 24 * 3103);
    expect(walk.average).toBeLessThan(3119);
    expect(walk.unfilled).toBe(0);
  });

  test('reports what the book could not absorb', () => {
    const walk = walkBook(bids, 500);
    expect(walk.filled).toBe(199);
    expect(walk.unfilled).toBe(301);
  });

  test('an empty book fills nothing and prices nothing', () => {
    expect(walkBook([], 10)).toEqual({ filled: 0, gross: 0, average: 0, unfilled: 10 });
  });
});
