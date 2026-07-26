/**
 * Mode resolution: map a `platformer | iso | fps` name to the {@link ModePlugin} that supplies
 * its systems, components and view projection.
 *
 * The default resolver wires the three real `@aegis/mode-*` plugins, so the CLI drives whatever
 * those parallel sessions ship. It is a small injectable seam ({@link ModeResolver}) rather than
 * hard-wired lookups, so tests can substitute a self-contained fake mode and prove the commands
 * actually execute — exactly how the harness verified its runner before any mode existed.
 * @packageDocumentation
 */
import { GAME_MODES, isGameMode } from '@aegis/core';
import type { GameMode } from '@aegis/core';
import type { ModePlugin } from '@aegis/harness';
import { platformerPlugin } from '@aegis/mode-platformer';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import { AegisCliError, CliCode } from './errors.js';

/** Resolves a mode name to its plugin. */
export interface ModeResolver {
  /** The modes this resolver knows about, in a stable order. */
  available(): readonly GameMode[];
  /** Whether `mode` is resolvable. */
  has(mode: string): boolean;
  /**
   * Resolve `mode` to its {@link ModePlugin}. Throws an {@link AegisCliError} with
   * {@link CliCode.UnknownMode} if the name is unsupported or unregistered.
   */
  resolve(mode: string): ModePlugin;
}

/** Build a {@link ModeResolver} from an explicit set of plugins (used by tests). */
export function createModeResolver(plugins: readonly ModePlugin[]): ModeResolver {
  const byMode = new Map<string, ModePlugin>();
  for (const plugin of plugins) byMode.set(plugin.mode, plugin);
  const available = [...byMode.keys()].filter(isGameMode).sort();

  return {
    available(): readonly GameMode[] {
      return available;
    },
    has(mode: string): boolean {
      return byMode.has(mode);
    },
    resolve(mode: string): ModePlugin {
      const plugin = byMode.get(mode);
      if (!plugin) {
        const known = available.join(', ') || '(none)';
        const isKnownName = GAME_MODES.some((known) => known === mode);
        throw new AegisCliError(
          CliCode.UnknownMode,
          isKnownName
            ? `Mode "${mode}" is not available in this resolver.`
            : `Unknown mode "${mode}".`,
          {
            fix: `Use one of: ${known}.`,
            data: { mode, available },
          },
        );
      }
      return plugin;
    },
  };
}

/** The default resolver wiring the three shipped mode plugins. */
export function defaultModeResolver(): ModeResolver {
  return createModeResolver([platformerPlugin, isoPlugin, fpsPlugin]);
}
