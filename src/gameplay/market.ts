interface MarketLine {
  item_id?: string;
  buy_price?: number;
  sell_price?: number;
}

export function bestBuyPrice(items: readonly MarketLine[], itemId: string): number | null {
  const prices = items
    .filter((i) => i.item_id === itemId && typeof i.buy_price === 'number')
    .map((i) => i.buy_price as number);
  return prices.length ? Math.min(...prices) : null;
}

export function bestSellPrice(items: readonly MarketLine[], itemId: string): number | null {
  const prices = items
    .filter((i) => i.item_id === itemId && typeof i.sell_price === 'number')
    .map((i) => i.sell_price as number);
  return prices.length ? Math.max(...prices) : null;
}
