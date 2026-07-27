// The composition root for playing the three proof-of-concept games in a browser.
//
// This file, not `packages/render-three/src/`, is where the renderer meets the games.
// `@aegis/render-three` is *engine*: `scripts/check-deps.mjs` forbids anything under `packages/`
// from importing anything under `games/`, by package name or by relative path — "the engine must
// NEVER depend on a game". The dev server is therefore game-agnostic (`startDevServer({ games })`
// takes a catalogue), and the three PoCs are wired in here.
//
// It used to live at `packages/render-three/poc-games.mjs`, where it imported all three
// `@aegis/game-*` packages — a straight violation of that rule that the checker did not see,
// because it scanned only `.ts` files under `src/` and `test/`. Both halves are fixed: the checker
// now scans project-root `.mjs`, and this wiring lives in `poc/`, which is deliberately **not** a
// workspace project. It may name both sides precisely because nothing can depend on it.
//
// The games are ordinary built workspace packages, imported by bare specifier. Nothing is
// transpiled, stripped or resolved by hand.
import { join } from 'node:path';
import { coyoteGapPlugin } from '@aegis/game-platformer';
import { serverVaultPlugin } from '@aegis/game-iso';
import { sectorBreachPlugin } from '@aegis/game-fps';
import { BINDINGS } from '../packages/render-three/dist/bindings.js';
import { findRepoRoot, loadInputScript, loadScene } from '../packages/render-three/dist/catalog.js';

/**
 * The three PoC games: id, presentation, the **composed** plugin, the scene it runs, the game's
 * own `.input` script, and what a completed playthrough looks like.
 *
 * The script and the acceptance pair are what let the screenshot capture refuse to ship a failed
 * run: it replays the same file the game's acceptance test runs, then requires the win event and
 * a live player. Both are the game's facts, declared here, where the renderer is allowed to know
 * them.
 */
const POC = [
  {
    id: 'platformer',
    title: 'Coyote Gap',
    blurb: 'Side-on platformer: coyote time, jump buffering, a moving platform and a critter.',
    objective: 'Cross the gaps and reach the goal volume on the far right.',
    plugin: coyoteGapPlugin,
    scene: 'games/platformer/levels/coyote-gap.scene.json',
    script: 'games/platformer/play/coyote-gap.input',
    // The tick count the game's own acceptance test runs, so the replay covers the same run.
    scriptTicks: 400,
    acceptance: { winEvent: 'level.completed', playerName: 'player' },
  },
  {
    id: 'iso',
    title: 'The Server Vault',
    blurb: 'Isometric infiltration: click-to-move A*, a patrolling guard, a switch and a door.',
    objective: 'Flip the switch to unseal the vault door, then reach the exit pad.',
    plugin: serverVaultPlugin,
    scene: 'games/iso/levels/server-vault.scene.json',
    script: 'games/iso/play/server-vault.input',
    scriptTicks: 960,
    acceptance: { winEvent: 'mission.completed', playerName: 'operative' },
  },
  {
    id: 'fps',
    title: 'Sector Breach',
    blurb: 'First person: hitscan weapon, a blast door, a coolant pit and a security grunt.',
    objective: 'Shoot the panel, jump the coolant pit, kill the grunt, reach the exit.',
    plugin: sectorBreachPlugin,
    scene: 'games/fps/levels/sector-breach.scene.json',
    script: 'games/fps/play/sector-breach.input',
    scriptTicks: 600,
    // Sector Breach wins by standing in a dead-end doorway, so the frame worth keeping is the
    // firefight. The tick still comes from the run's own event log.
    acceptance: {
      winEvent: 'level.completed',
      playerName: 'player',
      photoEvent: 'enemy.damaged',
    },
  },
];

/** Resolve a repo-relative POSIX path against the repository root. */
function at(root, relative) {
  return join(root, ...relative.split('/'));
}

/** Build the catalogue the dev server and the screenshot capture both serve. */
export async function pocGames() {
  const root = findRepoRoot();
  return Promise.all(
    POC.map(async (entry) => ({
      id: entry.id,
      title: entry.title,
      blurb: entry.blurb,
      objective: entry.objective,
      mode: entry.plugin.mode,
      plugin: entry.plugin,
      scene: await loadScene(at(root, entry.scene)),
      script: await loadInputScript(at(root, entry.script)),
      scriptTicks: entry.scriptTicks,
      acceptance: entry.acceptance,
      bindings: BINDINGS[entry.plugin.mode],
    })),
  );
}
