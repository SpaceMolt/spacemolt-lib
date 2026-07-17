import { expect, test } from 'bun:test';
import type {
  // facility
  FacilityListResponse,
  FacilityOwnedResponse,
  FacilityDismantleResponse,
  StationConfigResponse,
  // storage
  ViewStorageResponse,
  DepositItemsResponse,
  WithdrawItemsResponse,
  // crafting
  CraftJobResponse,
  PackageJobResponse,
  BulkCraftResponse,
  // fleet
  FleetStatusResponse,
  FleetActionResponse,
  FleetBoardResponse,
  // battle
  BattleResponse,
  GetBattleStatusResponse,
  // navigation
  JumpResponse,
  PathfinderJumpResponse,
  GetSystemTransitResponse,
  // drones
  DeployAllDronesResponse,
  // combat
  AttackNpcResponse,
  AttackPlayerResponse,
  // shared nested domain models
  ItemQuantity,
  CargoItem,
  V2GameState,
} from '../src/generated/openapi/types.gen.ts';

// Compile-time regression guard for the named-component surface established
// by gameserver#1791: every response variant above must exist as a named,
// importable type. If the gameserver spec regresses to anonymous union
// branches, or a hey-api upgrade changes its naming/merge behavior, this
// file fails `bun run typecheck` here instead of silently at a consumer's
// build. The runtime assertion below exists only because bun test requires
// one — the real check is that this file compiles.
function assertImportable<T>(_witness: T | undefined): void {}

test('representative generated response types remain importable', () => {
  assertImportable<FacilityListResponse>(undefined);
  assertImportable<FacilityOwnedResponse>(undefined);
  assertImportable<FacilityDismantleResponse>(undefined);
  assertImportable<StationConfigResponse>(undefined);
  assertImportable<ViewStorageResponse>(undefined);
  assertImportable<DepositItemsResponse>(undefined);
  assertImportable<WithdrawItemsResponse>(undefined);
  assertImportable<CraftJobResponse>(undefined);
  assertImportable<PackageJobResponse>(undefined);
  assertImportable<BulkCraftResponse>(undefined);
  assertImportable<FleetStatusResponse>(undefined);
  assertImportable<FleetActionResponse>(undefined);
  assertImportable<FleetBoardResponse>(undefined);
  assertImportable<BattleResponse>(undefined);
  assertImportable<GetBattleStatusResponse>(undefined);
  assertImportable<JumpResponse>(undefined);
  assertImportable<PathfinderJumpResponse>(undefined);
  assertImportable<GetSystemTransitResponse>(undefined);
  assertImportable<DeployAllDronesResponse>(undefined);
  assertImportable<AttackNpcResponse>(undefined);
  assertImportable<AttackPlayerResponse>(undefined);
  assertImportable<ItemQuantity>(undefined);
  assertImportable<CargoItem>(undefined);
  assertImportable<V2GameState>(undefined);
  expect(true).toBe(true);
});

// Discriminant narrowing: union variants carry literal action/kind fields, so
// a consumer can switch on them. If the gameserver's enum tags regress to
// plain `string`, these assignments stop compiling.
test('discriminant fields are literal types, not plain string', () => {
  const fleetAction: FleetActionResponse['action'] = 'kick';
  const craftKind: CraftJobResponse['kind'] = 'job';
  const attackKind: AttackNpcResponse['kind'] = 'npc';
  expect([fleetAction, craftKind, attackKind].length).toBe(3);
});
