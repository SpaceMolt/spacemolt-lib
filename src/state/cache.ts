/**
 * Per-account local cache of the eight game-state sections.
 *
 * Seeded canonically from a full `V2GameState` snapshot (the `get_status`
 * query returns exactly this shape) and kept current by applying the section
 * deltas carried on every `action_result`. Each present delta section is a
 * complete replacement for that section — absent sections are left untouched
 * (the server's "absent means unchanged" contract).
 */

import type { GameState, StateDelta, StateSection } from '../protocol.ts';
import { STATE_SECTIONS } from '../protocol.ts';
import type { V2GameState } from '../generated/openapi/types.gen.ts';

function asRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

export class StateCache {
  private state: GameState = {};

  /** Replace the cache from a canonical full snapshot (e.g. `get_status`). */
  seed(snapshot: V2GameState): StateSection[] {
    const next: GameState = {};
    const changed: StateSection[] = [];
    const src = asRecord(snapshot);
    for (const section of STATE_SECTIONS) {
      if (src[section] !== undefined) {
        asRecord(next)[section] = src[section];
        changed.push(section);
      }
    }
    this.state = next;
    return changed;
  }

  /**
   * Apply a delta, replacing each present section. Returns the sections that
   * changed (in `STATE_SECTIONS` order).
   */
  applyDelta(delta: StateDelta): StateSection[] {
    const changed: StateSection[] = [];
    const src = asRecord(delta);
    for (const section of STATE_SECTIONS) {
      if (src[section] !== undefined) {
        asRecord(this.state)[section] = src[section];
        changed.push(section);
      }
    }
    return changed;
  }

  /** Live view of the cached state. Treat as read-only — do not mutate. */
  snapshot(): Readonly<GameState> {
    return this.state;
  }

  get player(): GameState['player'] {
    return this.state.player;
  }
  get ship(): GameState['ship'] {
    return this.state.ship;
  }
  get location(): GameState['location'] {
    return this.state.location;
  }
  get cargo(): GameState['cargo'] {
    return this.state.cargo;
  }
  get modules(): GameState['modules'] {
    return this.state.modules;
  }
  get missions(): GameState['missions'] {
    return this.state.missions;
  }
  get skills(): GameState['skills'] {
    return this.state.skills;
  }
  /** True when a tick-deferred action is queued for this account. */
  get hasPendingAction(): boolean {
    return this.state.queue?.has_pending ?? false;
  }
  get credits(): number | undefined {
    return this.state.player?.credits;
  }
}
