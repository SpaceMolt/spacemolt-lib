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
export { ACTIONS } from './generated/actions.gen.ts';
export type { ToolName, ActionName, ActionDef, ActionParam } from './generated/actions.gen.ts';
export {
  TYPED_NOTIFICATION_TYPES,
} from './generated/notifications.gen.ts';
export type {
  NotificationPayloads,
  TypedNotificationType,
} from './generated/notifications.gen.ts';
