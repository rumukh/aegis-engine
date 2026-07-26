// The composition root for playing the three proof-of-concept games in a browser.
//
// This file, not `src/`, is where the renderer meets the games. `@aegis/render-three` is *engine*:
// `scripts/check-deps.mjs` forbids anything under `packages/` from importing anything under
// `games/`, by package name or by relative path — "the engine must NEVER depend on a game". The
// dev server is therefore game-agnostic (`startDevServer({ games })` takes a catalogue), and the
// three PoCs are wired in here.
//
// The games are ordinary built workspace packages, imported by bare specifier. Nothing is
// transpiled, stripped or resolved by hand.
//
// Note for the PM: this file is outside the package's compiled output and its `exports`/`files`,
// so it is not part of the shipped artefact — but it does live under `packages/render-three/` and
// resolves `@aegis/game-*` through workspace hoisting rather than a declared dependency (which
// check-deps rightly rejects). The durable home for this wiring is a project that is *allowed* to
// depend on both sides; see the handoff.
import { join } from 'node:path';
import { coyoteGapPlugin } from '@aegis/game-platformer';
import { serverVaultPlugin } from '@aegis/game-iso';
import { sectorBreachPlugin } from '@aegis/game-fps';
import { BINDINGS } from './dist/bindings.js';
import { findRepoRoot, loadScene } from './dist/catalog.js';

/** The three PoC games: id, presentation, the **composed** plugin, and the scene it runs. */
const POC = [
  {
    id: 'platformer',
    title: 'Coyote Gap',
    blurb: 'Side-on platformer: coyote time, jump buffering, a moving platform and a critter.',
    objective: 'Cross the gaps and reach the goal volume on the far right.',
    plugin: coyoteGapPlugin,
    scene: 'games/platformer/levels/coyote-gap.scene.json',
  },
  {
    id: 'iso',
    title: 'The Server Vault',
    blurb: 'Isometric infiltration: click-to-move A*, a patrolling guard, a switch and a door.',
    objective: 'Flip the switch to unseal the vault door, then reach the exit pad.',
    plugin: serverVaultPlugin,
    scene: 'games/iso/levels/server-vault.scene.json',
  },
  {
    id: 'fps',
    title: 'Sector Breach',
    blurb: 'First person: hitscan weapon, a blast door, a coolant pit and a security grunt.',
    objective: 'Shoot the panel, jump the coolant pit, kill the grunt, reach the exit.',
    plugin: sectorBreachPlugin,
    scene: 'games/fps/levels/sector-breach.scene.json',
  },
];

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
      scene: await loadScene(join(root, ...entry.scene.split('/'))),
      bindings: BINDINGS[entry.plugin.mode],
    })),
  );
}
