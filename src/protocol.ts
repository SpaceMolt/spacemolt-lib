/**
 * WebSocket v2 frame envelopes.
 *
 * These are the protocol-level message shapes — the framing layer that is
 * stable across spec versions (see gameserver docs/websocket-v2.md). The
 * per-action payloads and per-notification payloads are generated from the
 * spec instead (see src/generated/). Endpoint: `/ws/v2`.
 */

import type { NotificationPayloads, TypedNotificationType } from './generated/notifications.gen.ts';

/** Inbound frame: client -> server. `payload` is omitted when an action takes none. */
export interface InboundFrame {
  tool: string;
  action: string;
  payload?: Record<string, unknown>;
  /** Opaque correlation token, <= 128 bytes. Echoed back on result/outcome frames. */
  request_id?: string;
}

/** The synchronous query / mutation-ack response. */
export interface ResultFrame {
  type: 'result';
  request_id?: string;
  payload: {
    /** Human-readable rendered text (or raw object when no renderer applies). */
    result: unknown;
    /** Raw JSON for programmatic consumption. */
    structuredContent?: Record<string, unknown>;
  };
}

/** Mutation-ack: a `result` frame whose structuredContent flags `pending: true`. */
export interface PendingAck {
  pending: true;
  command: string;
  message: string;
}

/** Outcome push for a queued mutation; echoes the original request_id. */
export interface ActionResultFrame {
  type: 'action_result';
  request_id?: string;
  payload: {
    command: string;
    tick: number;
    /** A V2GameState delta — only the sections that changed. See StateDelta. */
    result: StateDelta;
    auto_docked?: boolean;
    auto_undocked?: boolean;
  };
}

/** Failure outcome for a queued mutation. */
export interface ActionErrorFrame {
  type: 'action_error';
  request_id?: string;
  payload: {
    command: string;
    tick: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Generic error frame emitted by the framing layer or a handler. */
export interface ErrorFrame {
  type: 'error';
  request_id?: string;
  payload: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    /** Only on `action_pending` errors: names the already-queued mutation. */
    pending_command?: string;
  };
}

/** Unsolicited frame sent immediately after the socket upgrade. No request_id. */
export interface WelcomeFrame {
  type: 'welcome';
  payload: {
    version: string;
    release_date: string;
    release_notes: string[];
    tick_rate: number;
    current_tick: number;
    server_time: number;
    motd?: string;
    game_info: string;
    website: string;
    help_text: string;
    terms: string;
  };
}

/** Auth success frame carrying the full initial session state. */
export interface LoggedInFrame {
  type: 'logged_in';
  request_id?: string;
  payload: Record<string, unknown>; // LoggedInPayload — typed in M2 against the spec
}

/** Auth success frame after `register`, carrying generated credentials. */
export interface RegisteredFrame {
  type: 'registered';
  request_id?: string;
  payload: {
    /** 256-bit hex credential — only chance to capture it. */
    password: string;
    player_id: string;
  };
}

/**
 * A server-initiated push frame whose msg_type has a published payload schema.
 * Unknown/untyped pushes are delivered as `RawFrame` (see below) until the
 * server types them.
 */
export type NotificationFrame = {
  [K in TypedNotificationType]: { type: K; payload: NotificationPayloads[K] };
}[TypedNotificationType];

/**
 * Any inbound frame as parsed off the wire, before classification. The router
 * narrows this to a specific frame type by `type`. A bare-`string` discriminant
 * is kept out of the typed `OutboundFrame` union so its members narrow cleanly.
 */
export interface RawFrame {
  type: string;
  request_id?: string;
  payload?: unknown;
}

export type OutboundFrame =
  | ResultFrame
  | ActionResultFrame
  | ActionErrorFrame
  | ErrorFrame
  | WelcomeFrame
  | LoggedInFrame
  | RegisteredFrame
  | NotificationFrame;

/**
 * A V2GameState delta carried on `action_result`. Only changed sections are
 * present; an absent section means unchanged (keep prior local state). The
 * eight tracked sections plus the convenience fields. Section payloads are
 * loosely typed here and tightened against the spec in M2.
 */
export interface StateDelta {
  player?: Record<string, unknown>;
  ship?: Record<string, unknown>;
  modules?: unknown[];
  cargo?: unknown[];
  location?: Record<string, unknown>;
  missions?: Record<string, unknown>;
  queue?: { has_pending: boolean };
  skills?: Record<string, unknown>;
  // convenience fields
  message?: string;
  details?: Record<string, unknown>;
  credits?: number;
}

/** Resolved value of a synchronous query command. */
export interface QueryResult {
  /** Human-readable rendered text (or raw object when no renderer applies). */
  result: unknown;
  /** Raw JSON for programmatic consumption. */
  structuredContent?: Record<string, unknown>;
}

/** The immediate `pending: true` acknowledgement for a queued mutation. */
export interface MutationAck {
  command: string;
  message: string;
}

/** Resolved value of a two-phase mutation, delivered when the action executes. */
export interface MutationResult {
  command: string;
  /** Game tick on which the action executed. */
  tick: number;
  /** The V2GameState delta — only the sections that changed. */
  delta: StateDelta;
  autoDocked?: boolean;
  autoUndocked?: boolean;
}

export const STATE_SECTIONS = [
  'player',
  'ship',
  'modules',
  'cargo',
  'location',
  'missions',
  'queue',
  'skills',
] as const;
export type StateSection = (typeof STATE_SECTIONS)[number];
