/**
 * Thin lifecycle wrapper over a web-standard WebSocket.
 *
 * Parses inbound text frames to `OutboundFrame` and hands them to `onFrame`;
 * serializes outbound `InboundFrame`s. Reconnection and re-auth are M4 — this
 * layer just owns one connection. The WebSocket implementation is injectable
 * (`webSocketFactory`) so the transport can be driven by a mock in tests and
 * so the browser/Bun/Node global `WebSocket` is used by default.
 */

import type { InboundFrame, RawFrame } from '../protocol.ts';
import { ConnectionClosedError } from '../errors.ts';
import { isRecord } from '../validation.ts';

/** The minimal web-standard WebSocket surface this library depends on. */
export interface MessageEventLike {
  data: unknown;
}

export interface CloseEventLike {
  code?: number;
  reason?: string;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'close', listener: (event: CloseEventLike) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Keeps DOM event classes internal instead of leaking them through the public API. */
class NativeWebSocketAdapter implements WebSocketLike {
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
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
        this.socket.addEventListener('open', () => args[1]());
        break;
      case 'message':
        this.socket.addEventListener('message', (event) => args[1]({ data: event.data }));
        break;
      case 'close':
        this.socket.addEventListener('close', (event) => args[1]({ code: event.code, reason: event.reason }));
        break;
      case 'error':
        this.socket.addEventListener('error', (event) => args[1](event));
        break;
    }
  }
}

// `WebSocket` is global in browsers, Bun, and Node 22+.
const defaultFactory: WebSocketFactory = (url) => new NativeWebSocketAdapter(url);

export interface SocketOptions {
  url: string;
  webSocketFactory?: WebSocketFactory;
}

export class Socket {
  private ws: WebSocketLike | null = null;
  private opened = false;
  private closed = false;

  /** Called for every parsed inbound frame. */
  onFrame?: (frame: RawFrame) => void;
  /** Called once when the connection closes (for any reason). */
  onClose?: (err: ConnectionClosedError) => void;

  constructor(private readonly opts: SocketOptions) {}

  /** Open the socket; resolves when the connection is established. */
  connect(): Promise<void> {
    const factory = this.opts.webSocketFactory ?? defaultFactory;
    const ws = factory(this.opts.url);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      ws.addEventListener('open', () => {
        this.opened = true;
        settled = true;
        resolve();
      });
      ws.addEventListener('message', (ev) => this.handleMessage(ev.data));
      ws.addEventListener('close', (ev) => {
        const err = new ConnectionClosedError('WebSocket connection closed', ev?.code, ev?.reason);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.markClosed(err);
      });
      ws.addEventListener('error', () => {
        if (!this.opened && !settled) {
          settled = true;
          reject(new ConnectionClosedError('WebSocket connection failed before open'));
        }
      });
    });
  }

  send(frame: InboundFrame): void {
    if (!this.ws || this.closed) throw new ConnectionClosedError('cannot send on a closed socket');
    this.ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.ws?.close();
  }

  /**
   * The server batches multiple pushes into a single WebSocket message as
   * newline-delimited JSON under load (confirmed live: a burst of
   * reconnect-related frames arrived as one message,
   * `{"type":"reconnected",...}\n{"type":"logged_in",...}`). A JSON string
   * value's own newlines are always escaped (`\n`, two characters) by any
   * conforming serializer, so a raw newline byte in the message text is only
   * ever a frame separator, never content — splitting on it is safe. Each
   * line is parsed and routed independently, so one malformed line in a
   * batch no longer takes every other frame in that same message down with
   * it (the previous behavior: parsing the whole batch as one JSON value,
   * which always failed whenever more than one frame arrived together).
   */
  private handleMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : String(data);
    for (const line of text.split('\n')) {
      if (!line) continue;
      let frame: RawFrame;
      try {
        const parsed: unknown = JSON.parse(line);
        if (
          !isRecord(parsed) ||
          typeof parsed.type !== 'string' ||
          (parsed.request_id !== undefined && typeof parsed.request_id !== 'string')
        )
          throw new TypeError('frame must be an object with a type');
        frame = { ...parsed, type: parsed.type };
      } catch (err) {
        // A frame that fails to parse is otherwise 100% silent — no trace it
        // ever arrived. head/tail samples (not the full body, to bound log
        // volume) are what distinguish truncation from genuine garbage.
        const head = line.slice(0, 200);
        const tail = line.length > 400 ? line.slice(-200) : '';
        console.warn(
          `[spacemolt] dropped unparseable frame (${line.length} bytes): ${err} | head=${JSON.stringify(head)}${tail ? ` tail=${JSON.stringify(tail)}` : ''}`,
        );
        continue;
      }
      this.onFrame?.(frame);
    }
  }

  private markClosed(err: ConnectionClosedError): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(err);
  }
}
