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

/**
 * Custom WS close codes the server documents (as of gameserver v0.471.4):
 * `4001` session_replaced (another connection took your slot — don't
 * reconnect, you'd just fight it), `4002` auth_timeout (connected but didn't
 * authenticate in time), `4003` connection_rate_limited (exceeded the
 * 100/min-per-IP WS-connection cap — the close reason carries a
 * `retry_after=<seconds>` hint; honor it before reconnecting).
 */
export const CLOSE_CODE = {
  SESSION_REPLACED: 4001,
  AUTH_TIMEOUT: 4002,
  CONNECTION_RATE_LIMITED: 4003,
} as const;

/**
 * Parses the `retry_after=<seconds>` hint the server includes on a `4003`
 * (connection_rate_limited) close reason. Returns the wait time in
 * milliseconds, or `undefined` if `err` isn't a rate-limited close or carries
 * no parseable hint.
 */
export function retryAfterMsFromClose(err: unknown): number | undefined {
  if (!(err instanceof ConnectionClosedError) || err.code !== CLOSE_CODE.CONNECTION_RATE_LIMITED) return undefined;
  const match = err.reason?.match(/retry_after=(\d+)/);
  return match ? Number(match[1]) * 1000 : undefined;
}
