/**
 * Local cache of subscribed station order books.
 *
 * Seeded from the `subscribe_market` baseline snapshot and kept current by
 * merging `market_update` pushes (which carry only the items that changed).
 * Keyed by `base_id`; items keyed by `item_id`.
 */

import type { NotificationMarketUpdate, SubscribeMarketResponse } from '../generated/openapi/types.gen.ts';

export type MarketItem = NotificationMarketUpdate['items'][number];

export interface MarketBook {
  base_id: string;
  base_name?: string;
  /** Tick of the most recent update (0 from the initial baseline). */
  tick: number;
  /** Order book per item_id. */
  items: Map<string, MarketItem>;
}

export class MarketCache {
  private readonly books = new Map<string, MarketBook>();

  /** Seed (or replace) a base's book from a subscribe_market baseline. */
  seed(snapshot: SubscribeMarketResponse): string | undefined {
    if (!snapshot.base_id) return undefined;
    const items = new Map<string, MarketItem>();
    for (const item of snapshot.items ?? []) {
      if (item.item_id) items.set(item.item_id, item);
    }
    this.books.set(snapshot.base_id, {
      base_id: snapshot.base_id,
      base_name: snapshot.base_name,
      tick: 0,
      items,
    });
    return snapshot.base_id;
  }

  /** Merge a market_update push (changed items only) into the book. */
  applyUpdate(update: NotificationMarketUpdate): void {
    let book = this.books.get(update.base_id);
    if (!book) {
      book = { base_id: update.base_id, base_name: update.base_name, tick: update.tick, items: new Map() };
      this.books.set(update.base_id, book);
    }
    book.tick = update.tick;
    if (update.base_name) book.base_name = update.base_name;
    for (const item of update.items) book.items.set(item.item_id, item);
  }

  /** The cached book for a base, if subscribed. */
  book(baseId: string): MarketBook | undefined {
    return this.books.get(baseId);
  }

  /** All base_ids with a cached book. */
  bases(): string[] {
    return [...this.books.keys()];
  }

  /** Drop a base's cached book (e.g. on unsubscribe). */
  drop(baseId: string): void {
    this.books.delete(baseId);
  }
}
