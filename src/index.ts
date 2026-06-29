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
  type ReconnectOptions,
  type RegisterParams,
  type RegisterResult,
  type LoggedInPayload,
} from './account.ts';
export { SpacemoltClient, type SpacemoltClientOptions } from './client.ts';
export {
  type CredentialStore,
  type StoredAccount,
  type AuthCredentials,
  MemoryCredentialStore,
} from './auth/credentials.ts';
export { FileCredentialStore } from './auth/file-store.ts';
export { SpacemoltError, ConnectionClosedError } from './errors.ts';
export { StateCache } from './state/cache.ts';
export { MarketCache, type MarketBook, type MarketItem } from './state/market.ts';
export {
  ObservationCache,
  type ObservationView,
  type ObservedPlayer,
  type CloakedContact,
} from './state/observation.ts';
export { TypedEmitter, EventStream } from './events/emitter.ts';
export { type Commands, type CommandDispatch, buildCommands } from './generated/commands.gen.ts';
export { CatalogCache, fetchCatalog, type Catalog, type CatalogEntry } from './data/catalog.ts';
export { MapCache, fetchMap, httpBaseFromWs, type GalaxyMap, type MapSystem } from './data/map.ts';
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
