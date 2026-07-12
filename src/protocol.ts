/**
 * WebSocket v2 frame envelopes.
 *
 * These are the protocol-level message shapes — the framing layer that is
 * stable across spec versions (see gameserver docs/websocket-v2.md). The
 * per-action payloads and per-notification payloads are generated from the
 * spec instead (see src/generated/). Endpoint: `/ws/v2`.
 */

import type { NotificationPayloads, TypedNotificationType } from './generated/notifications.gen.ts';
import type { V2GameState } from './generated/openapi/types.gen.ts';
import { isRecord } from './validation.ts';

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

function hasPayload(frame: RawFrame): frame is RawFrame & { payload: Record<string, unknown> } {
  return isRecord(frame.payload);
}

export function isResultFrame(frame: RawFrame): frame is ResultFrame {
  return (
    frame.type === 'result' &&
    hasPayload(frame) &&
    'result' in frame.payload &&
    (frame.payload.structuredContent === undefined || isRecord(frame.payload.structuredContent))
  );
}

export function isActionResultFrame(frame: RawFrame): frame is ActionResultFrame {
  return (
    frame.type === 'action_result' &&
    hasPayload(frame) &&
    typeof frame.payload.command === 'string' &&
    typeof frame.payload.tick === 'number' &&
    isRecord(frame.payload.result) &&
    (frame.payload.auto_docked === undefined || typeof frame.payload.auto_docked === 'boolean') &&
    (frame.payload.auto_undocked === undefined || typeof frame.payload.auto_undocked === 'boolean')
  );
}

export function isActionErrorFrame(frame: RawFrame): frame is ActionErrorFrame {
  return (
    frame.type === 'action_error' &&
    hasPayload(frame) &&
    typeof frame.payload.command === 'string' &&
    typeof frame.payload.tick === 'number' &&
    typeof frame.payload.code === 'string' &&
    typeof frame.payload.message === 'string' &&
    (frame.payload.details === undefined || isRecord(frame.payload.details))
  );
}

export function isErrorFrame(frame: RawFrame): frame is ErrorFrame {
  return (
    frame.type === 'error' &&
    hasPayload(frame) &&
    typeof frame.payload.code === 'string' &&
    typeof frame.payload.message === 'string' &&
    (frame.payload.details === undefined || isRecord(frame.payload.details)) &&
    (frame.payload.pending_command === undefined || typeof frame.payload.pending_command === 'string')
  );
}

export function isWelcomeFrame(frame: RawFrame): frame is WelcomeFrame {
  return (
    frame.type === 'welcome' &&
    hasPayload(frame) &&
    typeof frame.payload.version === 'string' &&
    typeof frame.payload.release_date === 'string' &&
    Array.isArray(frame.payload.release_notes) &&
    frame.payload.release_notes.every((note) => typeof note === 'string') &&
    typeof frame.payload.tick_rate === 'number' &&
    typeof frame.payload.current_tick === 'number' &&
    typeof frame.payload.server_time === 'number' &&
    (frame.payload.motd === undefined || typeof frame.payload.motd === 'string') &&
    typeof frame.payload.game_info === 'string' &&
    typeof frame.payload.website === 'string' &&
    typeof frame.payload.help_text === 'string' &&
    typeof frame.payload.terms === 'string'
  );
}

export function isLoggedInFrame(frame: RawFrame): frame is LoggedInFrame {
  return frame.type === 'logged_in' && hasPayload(frame);
}

export function isRegisteredFrame(frame: RawFrame): frame is RegisteredFrame {
  return (
    frame.type === 'registered' &&
    hasPayload(frame) &&
    typeof frame.payload.password === 'string' &&
    typeof frame.payload.player_id === 'string'
  );
}

/**
 * The cacheable game-state sections — the eight independently-tracked sections
 * the server emits deltas for. Section shapes are derived from the spec's
 * `V2GameState`, so they stay correct as the spec evolves.
 */
export type GameState = Pick<
  V2GameState,
  'player' | 'ship' | 'modules' | 'cargo' | 'location' | 'missions' | 'queue' | 'skills'
>;

/**
 * A `V2GameState` delta carried on `action_result`. Only changed sections are
 * present; an absent section means unchanged (keep prior local state). Carries
 * the same eight sections as `GameState` plus the per-action convenience fields.
 */
export type StateDelta = GameState & Pick<V2GameState, 'message' | 'details' | 'credits'>;

/**
 * Resolved value of a synchronous query command. `T` is the command's specific
 * `structuredContent` shape; the generated command facade binds it per command
 * (e.g. `find_route` → `QueryResult<FindRouteResponse>`), so reads are typed with
 * no cast. Defaults to untyped JSON for the low-level `query`/`send` paths.
 */
export interface QueryResult<T = Record<string, unknown>> {
  /** Human-readable rendered text (or raw object when no renderer applies). */
  result: unknown;
  /** Raw JSON for programmatic consumption, typed to the command's response. */
  structuredContent?: T;
}

/** The immediate `pending: true` acknowledgement for a queued mutation. */
export interface MutationAck {
  command: string;
  message: string;
}

/**
 * Resolved value of a two-phase mutation, delivered when the action executes.
 * `TDetails` is the action-specific shape of `delta.details` (e.g. `jump` ->
 * `MutationResult<JumpResponse>`); the generated command facade binds it per
 * command, so reads are typed with no cast. The rest of `delta` (the state
 * sections that changed) is the same generic shape for every mutation — only
 * `details` is action-specific. Defaults to untyped JSON for the low-level
 * `mutate`/`send` paths.
 */
export interface MutationResult<TDetails = Record<string, unknown>> {
  command: string;
  /** Game tick on which the action executed. */
  tick: number;
  /** The V2GameState delta — only the sections that changed. */
  delta: Omit<StateDelta, 'details'> & { details?: TDetails };
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
