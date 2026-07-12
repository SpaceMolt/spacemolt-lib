/**
 * Typed event dispatch for server push frames.
 *
 * Callbacks (`on`/`onAny`) and async iterators (`stream`/`anyStream`) are both
 * supported. The Account facade adds the per-msg_type payload typing on top of
 * this (loosely-typed) core.
 */

import type { RawFrame } from '../protocol.ts';

type PayloadHandler = (payload: unknown) => void;
type FrameHandler = (frame: RawFrame) => void;

/**
 * An async iterator over events of one kind, with internal buffering so a slow
 * consumer doesn't drop frames. Breaking out of a `for await` calls `return()`,
 * which unsubscribes via the `onClose` callback.
 */
export class EventStream<T> implements AsyncIterableIterator<T> {
  private readonly buffer: Array<{ value: T }> = [];
  private readonly waiting: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  constructor(private readonly onClose: () => void) {}

  /** Internal: deliver a value to the consumer or buffer it. */
  push(value: T): void {
    if (this.ended) return;
    const next = this.waiting.shift();
    if (next) next({ value, done: false });
    else this.buffer.push({ value });
  }

  /** Internal: end the stream (e.g. on disconnect). */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiting) w({ value: undefined, done: true });
    this.waiting.length = 0;
  }

  next(): Promise<IteratorResult<T>> {
    const buffered = this.buffer.shift();
    if (buffered) return Promise.resolve({ value: buffered.value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.end();
    this.onClose();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export class TypedEmitter {
  private readonly handlers = new Map<string, Set<PayloadHandler>>();
  private readonly anyHandlers = new Set<FrameHandler>();
  private readonly streams = new Map<string, Set<EventStream<unknown>>>();
  private readonly anyStreams = new Set<EventStream<RawFrame>>();

  /** Listen for one msg_type. Returns an unsubscribe function. */
  on<T = unknown>(type: string, handler: (payload: T) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const wrapped: PayloadHandler = (payload) => handler(payload as T);
    set.add(wrapped);
    return () => set.delete(wrapped);
  }

  /** Listen for every push frame. Returns an unsubscribe function. */
  onAny(handler: FrameHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  /** Async-iterate one msg_type's payloads. */
  stream(type: string): EventStream<unknown> {
    let set = this.streams.get(type);
    if (!set) {
      set = new Set();
      this.streams.set(type, set);
    }
    const localSet = set;
    const s = new EventStream<unknown>(() => localSet.delete(s));
    localSet.add(s);
    return s;
  }

  /** Async-iterate every push frame. */
  anyStream(): EventStream<RawFrame> {
    const s = new EventStream<RawFrame>(() => this.anyStreams.delete(s));
    this.anyStreams.add(s);
    return s;
  }

  /**
   * Dispatch a push frame to all matching listeners and streams. Each
   * callback is isolated with try/catch — this is the single funnel every
   * `account.on(type, ...)`/`onAny` consumer runs through, invoked directly
   * from `routeFrame`'s `default:` case with nothing above it to contain a
   * throw. Without isolation, one listener throwing would skip every other
   * listener/stream for this frame and propagate out through `routeFrame`
   * into the WebSocket's `message` event handler, which has no try/catch of
   * its own either.
   */
  emit(frame: RawFrame): void {
    const set = this.handlers.get(frame.type);
    if (set) for (const h of [...set]) this.safeCall(() => h(frame.payload));
    for (const h of [...this.anyHandlers]) this.safeCall(() => h(frame));
    const streams = this.streams.get(frame.type);
    if (streams) for (const s of [...streams]) this.safeCall(() => s.push(frame.payload));
    for (const s of [...this.anyStreams]) this.safeCall(() => s.push(frame));
  }

  private safeCall(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.warn(`[spacemolt] notification listener threw: ${err}`);
    }
  }

  /** End every open stream (on disconnect). Callback listeners are kept. */
  closeStreams(): void {
    for (const set of this.streams.values()) for (const s of set) s.end();
    for (const s of this.anyStreams) s.end();
  }
}
