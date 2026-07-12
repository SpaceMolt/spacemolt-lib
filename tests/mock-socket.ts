/**
 * A scriptable in-memory WebSocket for transport tests. Implements the
 * `WebSocketLike` surface the library depends on, and exposes helpers to
 * observe client sends and inject server frames.
 */

import type { CloseEventLike, MessageEventLike, WebSocketFactory, WebSocketLike } from '../src/transport/socket.ts';
import type { InboundFrame, RawFrame } from '../src/protocol.ts';
import { isRecord } from '../src/validation.ts';

type Listeners = {
  open: Array<() => void>;
  message: Array<(event: MessageEventLike) => void>;
  close: Array<(event: CloseEventLike) => void>;
  error: Array<(event: unknown) => void>;
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
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'close', listener: (event: CloseEventLike) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  addEventListener(
    ...args:
      | [type: 'open', listener: () => void]
      | [type: 'message', listener: (event: MessageEventLike) => void]
      | [type: 'close', listener: (event: CloseEventLike) => void]
      | [type: 'error', listener: (event: unknown) => void]
  ): void {
    switch (args[0]) {
      case 'open':
        this.listeners.open.push(args[1]);
        break;
      case 'message':
        this.listeners.message.push(args[1]);
        break;
      case 'close':
        this.listeners.close.push(args[1]);
        break;
      case 'error':
        this.listeners.error.push(args[1]);
        break;
    }
  }

  send(data: string): void {
    const parsed: unknown = JSON.parse(data);
    if (!isRecord(parsed) || typeof parsed.tool !== 'string' || typeof parsed.action !== 'string') {
      throw new TypeError('client sent a malformed inbound frame');
    }
    const frame: InboundFrame = {
      tool: parsed.tool,
      action: parsed.action,
      ...(isRecord(parsed.payload) ? { payload: parsed.payload } : {}),
      ...(typeof parsed.request_id === 'string' ? { request_id: parsed.request_id } : {}),
    };
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
