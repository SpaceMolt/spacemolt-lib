/** Error types surfaced by the library. */

import type { ActionErrorFrame, ErrorFrame } from './protocol.ts';

/**
 * A server-reported error. Carries the machine-readable `code` from the
 * server's error/action_error frame plus any structured details.
 */
export class SpacemoltError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
  /** Set when the failure came from a two-phase mutation outcome. */
  readonly command?: string;
  /** Game tick of the failure, for action_error outcomes. */
  readonly tick?: number;
  /** On `action_pending` errors: the mutation already queued. */
  readonly pendingCommand?: string;

  constructor(
    code: string,
    message: string,
    opts: {
      details?: Record<string, unknown>;
      requestId?: string;
      command?: string;
      tick?: number;
      pendingCommand?: string;
    } = {},
  ) {
    super(message);
    this.name = 'SpacemoltError';
    this.code = code;
    this.details = opts.details;
    this.requestId = opts.requestId;
    this.command = opts.command;
    this.tick = opts.tick;
    this.pendingCommand = opts.pendingCommand;
  }
}

export function errorFromFrame(frame: ErrorFrame): SpacemoltError {
  return new SpacemoltError(frame.payload.code, frame.payload.message, {
    details: frame.payload.details,
    requestId: frame.request_id,
    pendingCommand: frame.payload.pending_command,
  });
}

export function errorFromActionFrame(frame: ActionErrorFrame): SpacemoltError {
  return new SpacemoltError(frame.payload.code, frame.payload.message, {
    details: frame.payload.details,
    requestId: frame.request_id,
    command: frame.payload.command,
    tick: frame.payload.tick,
  });
}

/** Raised against every in-flight request when the socket closes. */
export class ConnectionClosedError extends Error {
  readonly code?: number;
  readonly reason?: string;
  constructor(message = 'WebSocket connection closed', code?: number, reason?: string) {
    super(message);
    this.name = 'ConnectionClosedError';
    this.code = code;
    this.reason = reason;
  }
}
