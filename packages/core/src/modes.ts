/**
 * The three first-class game modes (CHARTER §4.1). This is a neutral label shared by the
 * scene format, the harness's semantic frame, the mode packages and the renderer, so it
 * lives in dependency-free `@aegis/core`. Core attaches no behaviour to it.
 * @packageDocumentation
 */

/** The supported game modes. */
export const GAME_MODES = ['platformer', 'iso', 'fps'] as const;

/** One of the three supported modes. */
export type GameMode = (typeof GAME_MODES)[number];

/** Whether a string is a known {@link GameMode}. */
export function isGameMode(value: string): value is GameMode {
  return (GAME_MODES as readonly string[]).includes(value);
}
