/**
 * Correlates server response frames to in-flight requests by `request_id`.
 *
 * Two request shapes:
 *   - query    resolves on the synchronous `result` frame.
 *   - mutation is two-phase: a `result` ack (`pending: true`) arrives first,
 *              then — possibly many ticks later — an `action_result`
 *              (resolve) or `action_error` (reject). A synchronous validation
 *              failure short-circuits to an `error` frame (reject).
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
        // mutation: this is the pending ack — record it and keep waiting for
        // the action_result outcome.
        const structured = payload.structuredContent;
        const ack: MutationAck = {
          command: String(structured?.command ?? ''),
          message: String(structured?.message ?? ''),
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
