/**
 * The composed {@link ModePlugin} for "Coyote Gap": the platformer mode's systems +
 * `@aegis/content`'s `healthSystem` + the game's own systems, sharing the mode's `init`
 * (collision baking), component set and view projection.
 *
 * ## Why a composed plugin (and not the bare `platformerPlugin`)
 * The harness composes a run's schedule *only* from `plugin.systems()` (`runScene`/`executeRun`):
 * there is no separate hook to append game systems. So a game that needs its own systems (patrol,
 * stomp, death mapping, goal) must expose them through a plugin. This plugin *is* the mode plugin
 * with the game and content systems folded in — it still reports `mode: 'platformer'` and reuses
 * the mode's `init`/`view` verbatim. The mode contract is untouched; only the schedule is richer.
 * @packageDocumentation
 */
import { createSchedule } from '@aegis/core';
import type { GameMode, Schedule, World } from '@aegis/core';
import { healthSystem } from '@aegis/content';
import type { ModePlugin, ViewProvider } from '@aegis/harness';
import {
  platformerInit,
  platformerView,
  PLATFORMER_COMPONENTS,
  PLATFORMER_SYSTEM_LIST,
} from '@aegis/mode-platformer';
import { COYOTE_GAP_COMPONENTS } from './components.js';
import { COYOTE_GAP_GAME_SYSTEMS } from './systems.js';

/** Build the full Coyote Gap schedule: mode movement/collision + content health + game logic. */
export function coyoteGapSchedule(): Schedule {
  return createSchedule().addAll([
    ...PLATFORMER_SYSTEM_LIST,
    healthSystem,
    ...COYOTE_GAP_GAME_SYSTEMS,
  ]);
}

/** The Coyote Gap plugin — the platformer mode with the game's systems and components folded in. */
export const coyoteGapPlugin: ModePlugin = {
  mode: 'platformer' as GameMode,
  components: () => [...PLATFORMER_COMPONENTS, ...COYOTE_GAP_COMPONENTS],
  init: (world: World): void => platformerInit(world),
  systems: () => coyoteGapSchedule(),
  view: (): ViewProvider => platformerView(),
};
