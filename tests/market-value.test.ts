/**
 * Unit tests for the pure market selectors in `src/data/market-value.ts`.
 * Fixtures mirror shapes observed on the live server.
 */

import { expect, test } from 'bun:test';
import { bestAsk, bestBid, bidDepth, valueBasket, walkBook } from '../src/index.ts';
import type { MarketListingItem } from '../src/index.ts';

function row(partial: Partial<MarketListingItem> & { item_id: string }): MarketListingItem {
  return {
    item_name: partial.item_id,
    category: 'material',
    sell_orders: [],
    buy_orders: [],
    best_sell: 0,
    best_buy: 0,
    sell_quantity: 0,
    sell_price: 0,
    best_sell_qty: 0,
    buy_quantity: 0,
    buy_price: 0,
    best_buy_qty: 0,
    ...partial,
  };
}

test('bestBid/bidDepth read the top of the buy book, 0 when absent', () => {
  const rows = [row({ item_id: 'steel_plate', best_buy: 54, best_buy_qty: 11588 })];
  expect(bestBid(rows, 'steel_plate')).toBe(54);
  expect(bidDepth(rows, 'steel_plate')).toBe(11588);
  expect(bestBid(rows, 'nonexistent')).toBe(0);
  expect(bidDepth(rows, 'nonexistent')).toBe(0);
});

test('bestAsk reads the top of the sell book, 0 when nothing is offered', () => {
  const rows = [row({ item_id: 'ore', best_sell: 12 })];
  expect(bestAsk(rows, 'ore')).toBe(12);
  expect(bestAsk(rows, 'nonexistent')).toBe(0);
});

test('walkBook consumes levels in order rather than assuming the best price', () => {
  const bids = [
    { price: 3119, quantity: 126 },
    { price: 3103, quantity: 56 },
    { price: 3084, quantity: 17 },
  ];
  // Inside the top level, best price holds.
  expect(walkBook(bids, 100)).toEqual({ filled: 100, gross: 311_900, average: 3119, unfilled: 0 });
  // Past it, the average slips — the naive quantity x best_bid overstates.
  const deep = walkBook(bids, 150);
  expect(deep.filled).toBe(150);
  expect(deep.gross).toBe(126 * 3119 + 24 * 3103);
  expect(deep.average).toBeLessThan(3119);
  // Beyond the whole book, the remainder is reported rather than silently dropped.
  expect(walkBook(bids, 300).unfilled).toBe(300 - 199);
  expect(walkBook([], 10)).toEqual({ filled: 0, gross: 0, average: 0, unfilled: 10 });
});

test('valueBasket prices each line at top-of-book, reporting unpriced items separately', () => {
  const rows = [
    row({ item_id: 'steel_plate', best_buy: 54, best_sell: 60 }),
    row({ item_id: 'ore', best_buy: 0, best_sell: 10 }), // no bid here
  ];
  const bidValue = valueBasket(
    rows,
    [
      { item_id: 'steel_plate', quantity: 10 },
      { item_id: 'ore', quantity: 5 },
    ],
    'bid',
  );
  expect(bidValue).toEqual({ total: 540, priced: 1, unpriced: ['ore'] });

  const askValue = valueBasket(rows, [{ item_id: 'steel_plate', quantity: 2 }], 'ask');
  expect(askValue).toEqual({ total: 120, priced: 1, unpriced: [] });
});

test('valueBasket reports every line as unpriced when the item is unknown', () => {
  expect(valueBasket([], [{ item_id: 'ghost', quantity: 1 }], 'bid')).toEqual({
    total: 0,
    priced: 0,
    unpriced: ['ghost'],
  });
});
