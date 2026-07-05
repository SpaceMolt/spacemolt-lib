/**
 * Correlates server response frames to in-flight requests by `request_id`.
 *
 * Two request shapes:
 *   - query    resolves on the synchronous `result` frame.
 *   - mutation is usually two-phase: a `result` ack (`pending: true`) arrives
 *              first, then — possibly many ticks later — an `action_result`
 *              (resolve) or `action_error` (reject). A synchronous validation
 *              failure short-circuits to an `error` frame (reject).
 *              But some mutation-classified actions resolve synchronously in
 *              a single `result` frame with no `pending: true` flag — nothing
 *              was queued, so no `action_result` is ever coming (e.g.
 *              `craft`/`recycle` with `dry_run: true`, which explicitly
 *              queues nothing). That `result` frame is treated as the final
 *              outcome instead of an ack, or the request would wait forever
 *              for an `action_result` the server was never going to send.
 *
 * Frames may interleave arbitrarily on the wire, so nothing here assumes
 * ordering beyond per-request_id sequencing.
 */

import type {
  ActionErrorFrame,
  ActionResultFrame,
  ErrorFrame,
  MutationAck,
  MutationResult,
  QueryResult,
  RawFrame,
  ResultFrame,
} from '../protocol.ts';
import { ConnectionClosedError, errorFromActionFrame, errorFromFrame, SpacemoltError } from '../errors.ts';

export type RequestKind = 'query' | 'mutation';

interface PendingBase {
  reject: (err: Error) => void;
}
interface PendingQuery extends PendingBase {
  kind: 'query';
  resolve: (value: QueryResult) => void;
}
interface PendingMutation extends PendingBase {
  kind: 'mutation';
  resolve: (value: MutationResult) => void;
  ack?: MutationAck;
  /** Optional hook fired when the pending ack arrives, before the outcome. */
  onAck?: (ack: MutationAck) => void;
}
type Pending = PendingQuery | PendingMutation;

export class Correlator {
  private readonly pending = new Map<string, Pending>();

  /** Register a query request; resolves on its `result` frame. */
  awaitQuery(requestId: string): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      this.pending.set(requestId, { kind: 'query', resolve, reject });
    });
  }

  /** Register a mutation request; resolves on its `action_result` outcome. */
  awaitMutation(requestId: string, onAck?: (ack: MutationAck) => void): Promise<MutationResult> {
    return new Promise<MutationResult>((resolve, reject) => {
      this.pending.set(requestId, { kind: 'mutation', resolve, reject, onAck });
    });
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Drop a pending request without settling it (e.g. after the caller gave up on a timeout). */
  cancel(requestId: string): void {
    this.pending.delete(requestId);
  }

  /**
   * Feed a frame to the correlator. Returns true if the frame was consumed
   * (matched an in-flight request), false otherwise (caller treats it as a
   * push frame).
   */
  handle(frame: RawFrame): boolean {
    const requestId = frame.request_id;
    if (!requestId) return false;
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    switch (frame.type) {
      case 'result': {
        const payload = (frame as ResultFrame).payload;
        if (pending.kind === 'query') {
          this.settle(requestId);
          pending.resolve({ result: payload.result, structuredContent: payload.structuredContent });
          return true;
        }
        const structured = payload.structuredContent;
        if (structured?.['pending'] !== true) {
          // Not an ack — this mutation resolved synchronously and nothing was
          // queued (e.g. a dry_run quote), so there's no action_result to
          // wait for. Settle now with this frame as the whole answer: no
          // state changed, so the only meaningful content is structuredContent
          // itself, carried as delta.details same as a real outcome would.
          this.settle(requestId);
          pending.resolve({
            command: String(structured?.['command'] ?? ''),
            tick: 0,
            delta: { details: structured },
          });
          return true;
        }
        // mutation: this is the pending ack — record it and keep waiting for
        // the action_result outcome.
        const ack: MutationAck = {
          command: String(structured['command'] ?? ''),
          message: String(structured['message'] ?? ''),
        };
        pending.ack = ack;
        pending.onAck?.(ack);
        return true;
      }
      case 'action_result': {
        if (pending.kind !== 'mutation') return true;
        const payload = (frame as ActionResultFrame).payload;
        this.settle(requestId);
        pending.resolve({
          command: payload.command,
          tick: payload.tick,
          delta: payload.result,
          autoDocked: payload.auto_docked,
          autoUndocked: payload.auto_undocked,
        });
        return true;
      }
      case 'action_error': {
        this.settle(requestId);
        pending.reject(errorFromActionFrame(frame as ActionErrorFrame));
        return true;
      }
      case 'error': {
        this.settle(requestId);
        pending.reject(errorFromFrame(frame as ErrorFrame));
        return true;
      }
      default:
        return false;
    }
  }

  /** Reject every in-flight request — used when the socket closes. */
  rejectAll(err: ConnectionClosedError | SpacemoltError): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private settle(requestId: string): void {
    this.pending.delete(requestId);
  }
}
