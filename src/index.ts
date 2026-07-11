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
  ClerkSource,
  mintWsToken,
  type ClerkPlayer,
  type ClerkSourceOptions,
} from './auth/clerk.ts';
export {
  type CredentialStore,
  type StoredAccount,
  type AuthCredentials,
  MemoryCredentialStore,
} from './auth/credentials.ts';
// FileCredentialStore imports node:fs — exported from '@spacemolt/lib/node'
// to keep this entry point browser-safe.
export { SpacemoltError, ConnectionClosedError, CLOSE_CODE, retryAfterMsFromClose } from './errors.ts';
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
export {
  CatalogCache,
  fetchCatalog,
  fetchCatalogConditional,
  type Catalog,
  type CatalogEntry,
  type CatalogFetchResult,
} from './data/catalog.ts';
export { MapCache, fetchMap, httpBaseFromWs, type GalaxyMap, type MapSystem } from './data/map.ts';
export {
  Socket,
  type SocketOptions,
  type WebSocketLike,
  type WebSocketFactory,
} from './transport/socket.ts';
export { ACTIONS, GENERATED_SPEC_VERSION } from './generated/actions.gen.ts';
export type { ToolName, ActionName, ActionDef, ActionParam } from './generated/actions.gen.ts';
// Every generated schema type (game objects + the per-command `*Response` shapes).
// Query commands already return `QueryResult<ResponseType>`, so `structuredContent`
// is typed without a cast; these exports let a consumer name the types explicitly,
// e.g. `import type { FindRouteResponse, V2GameState } from '@spacemolt/lib'`.
export type * from './generated/openapi/types.gen.ts';
export {
  TYPED_NOTIFICATION_TYPES,
} from './generated/notifications.gen.ts';
export type {
  NotificationPayloads,
  TypedNotificationType,
} from './generated/notifications.gen.ts';
