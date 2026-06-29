/**
 * @spacemolt/lib — the TypeScript library for SpaceMolt.
 *
 * WebSocket-v2-first, multi-account, with local state caches updated from
 * mutation deltas and server pushes. Library internals are regenerated from
 * the server's published OpenAPI spec (`bun run generate`).
 *
 * This is the M0 surface: protocol types and the generated command/notification
 * catalog. The runtime client (transport, accounts, state, events) lands in
 * subsequent milestones.
 */

export * from './protocol.ts';
export {
  Account,
  type AccountOptions,
  type RegisterParams,
  type RegisterResult,
  type LoggedInPayload,
} from './account.ts';
export { SpacemoltError, ConnectionClosedError } from './errors.ts';
export {
  Socket,
  type SocketOptions,
  type WebSocketLike,
  type WebSocketFactory,
} from './transport/socket.ts';
export { ACTIONS } from './generated/actions.gen.ts';
export type { ToolName, ActionName, ActionDef, ActionParam } from './generated/actions.gen.ts';
export {
  TYPED_NOTIFICATION_TYPES,
} from './generated/notifications.gen.ts';
export type {
  NotificationPayloads,
  TypedNotificationType,
} from './generated/notifications.gen.ts';
