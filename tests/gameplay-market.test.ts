import { describe, expect, test } from 'bun:test';
import { bestBuyPrice, bestSellPrice } from '../src/gameplay/market.ts';

describe('market helpers', () => {
  const items = [
    { item_id: 'ore', buy_price: 5, sell_price: 4 },
    { item_id: 'ore', buy_price: 3, sell_price: 6 },
  ];
  test('bestBuyPrice and bestSellPrice', () => {
    expect(bestBuyPrice(items, 'ore')).toBe(3);
    expect(bestSellPrice(items, 'ore')).toBe(6);
    expect(bestBuyPrice(items, 'none')).toBeNull();
  });
});
