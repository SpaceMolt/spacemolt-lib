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

/** The minimal web-standard WebSocket surface this library depends on. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { code?: number; reason?: string }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultFactory: WebSocketFactory = (url) =>
  // `WebSocket` is global in browsers, Bun, and Node 22+.
  new WebSocket(url) as unknown as WebSocketLike;

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

  private handleMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : String(data);
    let frame: RawFrame;
    try {
      frame = JSON.parse(text) as RawFrame;
    } catch (err) {
      // A frame that fails to parse is otherwise 100% silent — no trace it
      // ever arrived. This log exists to discriminate reports of "the server
      // never sent X": if this line never fires while a push/mutation-result
      // is reported missing, the loss is not a parse failure on this socket.
      // head/tail samples (not the full body, to bound log volume) are what
      // distinguish a truncated frame from a concatenation of multiple
      // frames from genuine garbage — worth the extra log line width.
      const head = text.slice(0, 200);
      const tail = text.length > 400 ? text.slice(-200) : '';
      console.warn(
        `[spacemolt] dropped unparseable frame (${text.length} bytes): ${err} | head=${JSON.stringify(head)}${tail ? ` tail=${JSON.stringify(tail)}` : ''}`,
      );
      return;
    }
    this.onFrame?.(frame);
  }

  private markClosed(err: ConnectionClosedError): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.(err);
  }
}
