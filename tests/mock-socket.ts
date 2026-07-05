/**
 * A scriptable in-memory WebSocket for transport tests. Implements the
 * `WebSocketLike` surface the library depends on, and exposes helpers to
 * observe client sends and inject server frames.
 */

import type { WebSocketLike, WebSocketFactory } from '../src/transport/socket.ts';
import type { InboundFrame, RawFrame } from '../src/protocol.ts';

type Listeners = {
  open: Array<() => void>;
  message: Array<(ev: { data: unknown }) => void>;
  close: Array<(ev: { code?: number; reason?: string }) => void>;
  error: Array<(ev: unknown) => void>;
};

export class MockSocket implements WebSocketLike {
  readonly sent: InboundFrame[] = [];
  /** Invoked for each client send; use to script server replies. */
  onClientSend?: (frame: InboundFrame, socket: MockSocket) => void;
  private readonly listeners: Listeners = { open: [], message: [], close: [], error: [] };
  private open = false;

  constructor(
    readonly url: string,
    private readonly opts: { failToOpen?: boolean } = {},
  ) {
    // Open asynchronously so the Socket can register listeners first.
    queueMicrotask(() => {
      if (this.opts.failToOpen) {
        // Simulate a rejected WS upgrade (e.g. a 429 from a per-IP rate
        // limit): the handshake never completes, so only error+close fire.
        for (const cb of this.listeners.error) cb({ message: 'rejected' });
        for (const cb of this.listeners.close) cb({ code: 1006, reason: 'rejected' });
        return;
      }
      this.open = true;
      for (const cb of this.listeners.open) cb();
    });
  }

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: keyof Listeners, listener: (ev: never) => void): void {
    (this.listeners[type] as Array<(ev: unknown) => void>).push(listener as (ev: unknown) => void);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as InboundFrame;
    this.sent.push(frame);
    this.onClientSend?.(frame, this);
  }

  close(code = 1000, reason = ''): void {
    if (!this.open) return;
    this.open = false;
    for (const cb of this.listeners.close) cb({ code, reason });
  }

  /** Push a server frame to the client (loosely typed — simulates raw bytes). */
  serverSend(frame: RawFrame): void {
    const data = JSON.stringify(frame);
    for (const cb of this.listeners.message) cb({ data });
  }

  /** Push raw (possibly malformed) bytes, bypassing JSON.stringify — for parse-failure tests. */
  serverSendRaw(data: string): void {
    for (const cb of this.listeners.message) cb({ data });
  }

  /** The request_id of the most recently sent frame (for echoing). */
  lastRequestId(): string | undefined {
    return this.sent[this.sent.length - 1]?.request_id;
  }
}

/** A factory that records every socket it creates. */
export function mockFactory(): { factory: WebSocketFactory; sockets: MockSocket[] } {
  const sockets: MockSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const s = new MockSocket(url);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}
