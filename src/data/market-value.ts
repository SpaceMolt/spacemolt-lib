/**
 * Pure market selectors — no `Account`, no I/O. Given a snapshot of
 * `view_market()` rows (or an order book's levels), decide prices, depth and
 * basket value. Kept separate from anything that fetches so it's testable
 * with plain fixtures.
 */

import type { CargoItem, MarketListingItem, OrderLevel } from '../generated/openapi/types.gen.ts';

/** Price a buyer here will pay us per unit (0 when nobody is bidding). */
export function bestBid(rows: readonly MarketListingItem[], itemId: string): number {
  return rows.find((r) => r.item_id === itemId)?.best_buy ?? 0;
}

/** Price we would pay per unit to buy here (0 when nothing is offered). */
export function bestAsk(rows: readonly MarketListingItem[], itemId: string): number {
  return rows.find((r) => r.item_id === itemId)?.best_sell ?? 0;
}

/**
 * Units a buyer here will take **at the best bid only**.
 *
 * This is the top price level, not total demand — and the gap is large. At
 * `frontier_station` fuel cells showed `best_buy_qty` 126 against a true
 * `buy_quantity` of 993 spread over 12 levels, so anything sizing a trade off
 * this figure understates the market roughly eightfold. Safe for "what can I
 * dump right now at the top price", wrong for "is this worth a trip".
 *
 * Use `walkBook` when the quantity matters.
 */
export function bidDepth(rows: readonly MarketListingItem[], itemId: string): number {
  return rows.find((r) => r.item_id === itemId)?.best_buy_qty ?? 0;
}

export interface BookWalk {
  /** Units actually filled. */
  filled: number;
  /** Total proceeds (or cost, walking asks). */
  gross: number;
  /** Realized price per filled unit, 0 when nothing filled. */
  average: number;
  /** Units the book could not absorb. */
  unfilled: number;
}

/**
 * What `quantity` really fetches, consuming levels in order.
 *
 * Takes the server's own levels — a `MarketListingItem`'s `buy_orders` /
 * `sell_orders` go straight in, best-first, no reshaping.
 *
 * Multiplying quantity by the best price overstates any order big enough to eat
 * through the top level — the second unit may be worth less than the first.
 * Pure, so the arithmetic is testable without a market.
 */
export function walkBook(levels: readonly OrderLevel[], quantity: number): BookWalk {
  let left = quantity;
  let gross = 0;
  for (const level of levels) {
    if (left <= 0) break;
    const take = Math.min(left, level.quantity);
    gross += take * level.price_each;
    left -= take;
  }
  const filled = quantity - left;
  return { filled, gross, average: filled > 0 ? gross / filled : 0, unfilled: left };
}

export interface BasketValue {
  /** Sum of priced lines. */
  total: number;
  /** Count of lines that had a price. */
  priced: number;
  /** item_ids with no bid/ask here, so they contributed nothing to `total`. */
  unpriced: string[];
}

/**
 * Value a basket of items at top-of-book prices only (best bid to sell, best
 * ask to buy) — one lookup per line, no book-walking. A line with no price
 * here (0) is reported in `unpriced` rather than silently valued at 0, since
 * the caller usually wants to know what it couldn't price.
 *
 * Use `walkBook` instead when a line's quantity is large enough that the top
 * price alone would misstate what it actually fetches.
 */
export function valueBasket(
  rows: readonly MarketListingItem[],
  basket: readonly CargoItem[],
  side: 'bid' | 'ask',
): BasketValue {
  const priceOf = side === 'bid' ? bestBid : bestAsk;
  let total = 0;
  let priced = 0;
  const unpriced: string[] = [];
  for (const line of basket) {
    const price = priceOf(rows, line.item_id);
    if (price <= 0) {
      unpriced.push(line.item_id);
      continue;
    }
    total += price * line.quantity;
    priced++;
  }
  return { total, priced, unpriced };
}
