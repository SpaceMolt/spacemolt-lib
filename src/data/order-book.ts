/**
 * Order-book arithmetic — pure, no `Account`, no I/O.
 *
 * Everything else about a market is already on the server's own payload: a
 * `MarketListingItem` carries `best_buy`/`best_sell` (top of book),
 * `best_buy_qty`/`best_sell_qty` (units at that top level only) and
 * `buy_quantity`/`sell_quantity` (total units across every level). Read those
 * fields directly — there are no accessors here, because a wrapper around
 * `rows.find(...)` would only add a local convention for the server to drift
 * away from.
 *
 * What the server does *not* publish is what a given order actually fetches
 * once it eats through the top level. That's `walkBook`.
 */

import type { OrderLevel } from '../generated/openapi/types.gen.ts';

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
 * through the top level: the second unit may be worth less than the first. At
 * `frontier_station` fuel cells showed a `best_buy_qty` of 126 against a
 * `buy_quantity` of 993 spread over 12 levels, so sizing a trade off the top
 * level alone understates the market roughly eightfold — and valuing all 993
 * at the best price overstates the proceeds. Walk the levels instead.
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
