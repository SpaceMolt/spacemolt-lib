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

function copySection<S extends StateSection>(target: GameState, source: GameState, section: S): boolean {
  const value = source[section];
  if (value === undefined) return false;
  target[section] = value;
  return true;
}

export class StateCache {
  private state: GameState = {};

  /** Replace the cache from a canonical full snapshot (e.g. `get_status`). */
  seed(snapshot: V2GameState): StateSection[] {
    const next: GameState = {};
    const changed: StateSection[] = [];
    for (const section of STATE_SECTIONS) {
      if (copySection(next, snapshot, section)) changed.push(section);
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
    for (const section of STATE_SECTIONS) {
      if (copySection(this.state, delta, section)) changed.push(section);
    }
    return changed;
  }

  /**
   * Merge a partial patch into a single section in place, preserving that
   * section's other fields — unlike `applyDelta`/`seed`, which always
   * replace a section wholesale. For bridging data from outside the normal
   * action_result delta flow (e.g. observation pushes patching
   * `location`'s nearby-player fields) into the corresponding section.
   * No-ops (returns `[]`) if the section hasn't been seeded yet, since a
   * partial patch can't stand in for a section's required fields.
   */
  patchSection<S extends StateSection>(section: S, patch: Partial<GameState[S]>): StateSection[] {
    const current = this.state[section];
    if (current === undefined) return [];
    this.state[section] = { ...current, ...patch };
    return [section];
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
