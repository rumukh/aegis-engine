/**
 * `aegis scaffold` — generate a new game skeleton (or a single document) so an agent can go from
 * nothing to a **runnable** game in one command (CHARTER principle 9).
 *
 * The bar here is not "writes files"; it is that `scaffold → validate → run → test` all succeed
 * on the output, from a directory that is not this repository. That forces three things the
 * previous template got wrong:
 *
 * 1. The scene **embeds its tilemap** under `resources`, exactly as the shipped games do — a
 *    tilemap file that nothing references gives a level with no ground, no collision and no
 *    ASCII view. `scaffold game` therefore writes *no* standalone `*.tilemap.json` at all: there
 *    is no scene → tilemap reference in the format, so a sibling file is a decoy you can edit all
 *    day without changing the run. `scaffold tilemap` still writes one on request.
 * 2. An **input script** is written, because a scene with no input is a player standing still;
 *    "it ran and nothing happened" is not a working scaffold.
 * 3. The starter test resolves its plugin **both** ways — importing `@aegis/mode-<mode>` when that
 *    package is reachable, falling back to the plugin *spec string* the CLI resolves when it is
 *    not — so the emitted file runs unmodified from a bare folder *and* under `runGameTest`.
 * 4. An `aegis.json` declares both the plugin and the test, so the naive `aegis run` resolves a
 *    plugin instead of silently falling back to stock, and `aegis test` counts this game.
 *
 * Writes are atomic: every target is checked before anything is written, and a mid-write failure
 * removes what this invocation created rather than leaving a half-scaffolded directory.
 * @packageDocumentation
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GAME_MODES } from '@aegis/core';
import type { GameMode } from '@aegis/core';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import { flagBool, flagChoice, flagString, requirePositional, resolvePath } from './shared.js';

const KINDS = ['game', 'scene', 'tilemap', 'test', 'prefab'] as const;
type Kind = (typeof KINDS)[number];

/** How many ticks the scaffolded test and input script cover. */
const TICKS = 120;

const USAGE = [
  'aegis scaffold <kind> <name> [options]',
  '',
  '  <kind>            game | scene | tilemap | test | prefab.',
  '                    "game" writes aegis.json + a scene + tilemap + input script + starter',
  '                    GameTest into <name>/, ready for: aegis validate / run / test.',
  '  --mode <mode>     platformer | iso | fps (default: platformer).',
  '  --out <dir>       Base directory to write into (default: cwd).',
  '  --force           Overwrite existing files.',
  '  --json            Emit the list of written files as JSON.',
  '',
  'Examples:',
  '  aegis scaffold game my-first --mode platformer',
  '  aegis scaffold scene level2 --mode iso',
  '  aegis scaffold test smoke --mode fps',
].join('\n');

/** A file to write: path relative to the base dir, plus its text content. */
interface Artifact {
  rel: string;
  content: string;
}

/** Pretty-print a JSON document with a trailing newline. */
function doc(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

// --- per-mode level data ----------------------------------------------------------------------

/**
 * The platformer's authored collision tilemap: solid ground along the bottom two rows.
 * Row 0 is the top; world Y counts up from the bottom row, so the ground surface is at y = 2.
 */
function platformerTilemap(name: string): Record<string, unknown> {
  const open = '.'.repeat(24);
  const solid = '#'.repeat(24);
  return {
    aegis: 'tilemap/1',
    name,
    width: 24,
    height: 8,
    tileSize: 1,
    legend: { '.': {}, '#': { solid: true, sprite: 'ground' } },
    layers: [{ name: 'collision', data: [open, open, open, open, open, open, solid, solid] }],
  };
}

/** The iso mode's authored grid resource: a walled room with a doorway. */
function isoGrid(): Record<string, unknown> {
  return {
    width: 10,
    height: 8,
    tileSize: 1,
    walls: [
      '##########',
      '#........#',
      '#..####..#',
      '#........#',
      '#..####..#',
      '#........#',
      '#........#',
      '##########',
    ],
  };
}

/** The fps mode's authored floorplan: a corridor from the spawn to the exit. */
function fpsFloorplan(): Record<string, unknown> {
  const wall = '#########';
  const open = '#.......#';
  return {
    width: 9,
    height: 20,
    tileSize: 1,
    origin: { x: -4, z: 0 },
    rows: [wall, ...Array.from({ length: 18 }, () => open), wall],
    legend: {
      '#': { solid: true, floor: 0, ceil: 4 },
      '.': { solid: false, floor: 0, ceil: 4 },
    },
  };
}

/** The scene document for `mode`, with its level data embedded under `resources`. */
function sceneDoc(name: string, mode: GameMode): string {
  const meta = {
    description: `Scaffolded ${mode} scene — replace with your level.`,
    scaffold: `aegis scaffold game ${name} --mode ${mode}`,
  };
  if (mode === 'iso') {
    return doc({
      aegis: 'scene/1',
      name,
      mode,
      seed: 1,
      resources: { IsoGrid: isoGrid() },
      entities: [
        {
          id: 'player',
          tags: ['Player', 'Controlled'],
          components: {
            GridPosition: { cellX: 1, cellY: 1, progress: 0 },
            IsoActor: { speed: 4, moveMode: 'realtime' },
            Health: { current: 10, max: 10 },
          },
        },
        {
          id: 'goal',
          tags: ['Goal'],
          components: {
            Transform: { position: { x: 8, y: 6, z: 0 } },
            Trigger: { kind: 'goal', shape: 'box', half: { x: 0.5, y: 0.5, z: 0.5 }, once: true },
          },
        },
        {
          id: 'camera',
          components: { IsoCamera: { target: 'player', viewHeight: 16, yawDegrees: 45 } },
        },
      ],
      meta,
    });
  }
  if (mode === 'fps') {
    return doc({
      aegis: 'scene/1',
      name,
      mode,
      seed: 1,
      resources: { 'fps.floorplan': fpsFloorplan() },
      entities: [
        {
          id: 'player',
          tags: ['Player'],
          components: {
            Transform: { position: { x: 0, y: 0, z: 1.5 } },
            CapsuleBody: {
              radius: 0.4,
              height: 1.8,
              velocity: { x: 0, y: 0, z: 0 },
              grounded: false,
            },
            FpsController: { moveSpeed: 6, gravity: 24, jumpSpeed: 8, maxPitchDeg: 89 },
            LookState: { yawDeg: 0, pitchDeg: 0 },
            FpsCamera: { eyeHeight: 1.6, fovDegrees: 75, near: 0.1, far: 1000 },
            Health: { current: 100, max: 100 },
          },
        },
        {
          id: 'goal',
          tags: ['Goal'],
          components: {
            Transform: { position: { x: 0, y: 0, z: 17 } },
            Trigger: { kind: 'goal', shape: 'box', half: { x: 1.5, y: 1.5, z: 1 }, once: true },
          },
        },
      ],
      meta,
    });
  }
  return doc({
    aegis: 'scene/1',
    name,
    mode,
    seed: 1,
    resources: { 'platformer.tilemap': platformerTilemap(name) },
    entities: [
      {
        id: 'player',
        tags: ['Player'],
        components: {
          Transform: { position: { x: 2.5, y: 3.5, z: 0 } },
          Velocity: { dx: 0, dy: 0 },
          PlatformerController: {},
          BodyState: {},
          TileCollider: { halfWidth: 0.4, halfHeight: 0.5 },
          Health: { current: 1, max: 1 },
        },
      },
      {
        id: 'goal',
        tags: ['Goal'],
        components: {
          Transform: { position: { x: 20.5, y: 2.5, z: 0 } },
          Trigger: { kind: 'goal', shape: 'box', half: { x: 1, y: 1, z: 1 }, once: true },
        },
      },
      {
        id: 'camera',
        components: {
          Transform: { position: { x: 2.5, y: 4, z: 10 } },
          PlatformerCamera: { target: 'player', deadzoneX: 3, deadzoneY: 2, viewHeight: 12 },
        },
      },
    ],
    meta,
  });
}

/**
 * The standalone tilemap document. For the platformer this is byte-identical to the copy the
 * scene embeds, so editing one and re-embedding it is a clean diff.
 */
function tilemapDoc(name: string, mode: GameMode): string {
  if (mode === 'platformer') return doc(platformerTilemap(name));
  return doc({
    aegis: 'tilemap/1',
    name,
    width: 8,
    height: 4,
    tileSize: 1,
    legend: { '.': {}, '#': { solid: true } },
    layers: [{ name: 'collision', data: ['........', '........', '........', '########'] }],
  });
}

/** A prefab template. */
function prefabDoc(name: string): string {
  return doc({
    aegis: 'prefab/1',
    name,
    tags: ['Actor'],
    components: { Transform: { position: { x: 0, y: 0, z: 0 } } },
  });
}

/** The scripted playthrough: the mode's way of saying "move for a while". */
function inputDoc(mode: GameMode): string {
  const header = [
    `# Scripted input for the scaffolded ${mode} game (ADR-0004 DSL).`,
    '# Run it with:  aegis run <scene> --ticks ' + TICKS + ' --input <this file>',
    '',
  ];
  if (mode === 'iso') return [...header, 'click 8,6 @2', ''].join('\n');
  if (mode === 'fps') return [...header, `axis Forward 1 0..${TICKS}`, ''].join('\n');
  return [...header, `hold Right 0..${TICKS}`, ''].join('\n');
}

/** The assertion body of the starter test, phrased in the mode's own vocabulary. */
function assertionsFor(mode: GameMode): string[] {
  if (mode === 'iso') {
    return [
      `    // A whole-timeline safety property. If the IsoGrid resource were missing or the`,
      `    // pathfinder walked the operative off the board, this fails on the exact tick it broke.`,
      `    result.assertInvariant('the operative stays inside the grid', (world) => {`,
      `      const cell = world.query({ has: ['Player', 'GridPosition'] }).one().get('GridPosition');`,
      `      return cell.cellX >= 0 && cell.cellX < 10 && cell.cellY >= 0 && cell.cellY < 8;`,
      `    });`,
      ``,
      `    // An end-state check: the click order in the input script must actually have moved it.`,
      `    const cell = result.query({ has: ['Player', 'GridPosition'] }).one().get('GridPosition');`,
      `    if (cell.cellX === 1 && cell.cellY === 1) {`,
      `      throw new Error('the operative never left its start cell (1,1) — check the input script');`,
      `    }`,
    ];
  }
  if (mode === 'fps') {
    return [
      `    // A whole-timeline safety property, chosen because it is genuinely falsifiable: remove`,
      `    // "fps.floorplan" from the scene and the capsule has nothing to stand on, so this fails`,
      `    // at tick 0 rather than 120 ticks later. Prefer an invariant a real regression breaks —`,
      `    // "y never drops below the floor" reads well but stays true here, because without`,
      `    // collision geometry the body simply never moves.`,
      `    result.assertInvariant('the player is standing on the floor every tick', (world) => {`,
      `      return world.query({ has: ['Player', 'CapsuleBody'] }).one().get('CapsuleBody').grounded;`,
      `    });`,
      ``,
      `    // An end-state check: the input script drives Forward, so z must have advanced.`,
      `    const z = result.query({ has: ['Player', 'Transform'] }).one().get('Transform').position.z;`,
      `    if (z <= 1.5) throw new Error('the player never moved forward (z=' + z + ')');`,
    ];
  }
  return [
    `    // A whole-timeline safety property. Remove "platformer.tilemap" from the scene's`,
    `    // resources and the player falls through the world — this fails on the exact tick it`,
    `    // happened, which is what makes an invariant more useful than an end-state check.`,
    `    result.assertInvariant('the player never falls out of the world', (world) => {`,
    `      const y = world.query({ has: ['Player', 'Transform'] }).one().get('Transform').position.y;`,
    `      return y > -5;`,
    `    });`,
    ``,
    `    // An end-state check: the input script holds Right, so the player must have advanced.`,
    `    const player = result.query({ has: ['Player', 'BodyState'] }).one();`,
    `    if (!player.get('BodyState').grounded) {`,
    `      throw new Error('the player is not standing on solid ground — is platformer.tilemap in the scene resources?');`,
    `    }`,
    `    const x = player.get('Transform').position.x;`,
    `    if (x <= 2.5) throw new Error('the player never moved right (x=' + x + ')');`,
  ];
}

/**
 * A starter GameTest that runs from the scaffolded directory **and** from inside a workspace.
 *
 * It resolves its plugin twice over: `import('@aegis/mode-<mode>')` when that package is
 * resolvable, and the plugin *spec string* the CLI resolves when it is not. A scaffolded folder
 * has no `node_modules`, so a hard bare import would fail with `Cannot find package` — but the
 * string-only form it replaced could not be run by `runGameTest` at all (only the CLI resolves
 * specs), so `runGameTest(spec)` on a scaffolded file died with
 * `TypeError: plugin.components is not a function`. Resolving both ways makes the emitted file
 * runnable unmodified in both places. The fallback catches only `ERR_MODULE_NOT_FOUND`: a mode
 * package that exists and throws must surface rather than degrade into a spec string.
 *
 * That constraint shapes the assertions, and the shape is the lesson. `result.assertInvariant()`
 * is a method on the result object, so it needs no import — and the harness **counts** it, which
 * matters: a game test that executes zero counted assertions is failed outright, on the grounds
 * that a run proving nothing must never report green. Hand-rolled `if (…) throw` checks are real
 * and do fail the test, but the harness cannot see them, so it cannot tell you what was verified.
 * A template that used only those would teach every scaffolded game to be invisible to the audit.
 */
function testDoc(name: string, mode: GameMode, sceneRel: string): string {
  const pkg = `@aegis/mode-${mode}`;
  const modePlugin = `${mode}Plugin`;
  return [
    `// Starter GameTest for "${name}" (${mode}).`,
    `//`,
    `//   aegis test                       # from this directory`,
    `//   aegis test "**/*.gametest.mjs"   # or point it at a glob`,
    `//`,
    `// The plugin is resolved twice over, so this file runs unmodified in both worlds:`,
    `//   * inside a workspace that has ${pkg} installed, the import wins and the`,
    `//     spec carries a real ModePlugin — so runGameTest(spec) works directly, in-process;`,
    `//   * in a bare scaffolded folder there is no node_modules, the import cannot resolve, and`,
    `//     the spec falls back to the *spec string* the CLI resolves for itself.`,
    `// Only a genuine "module not found" is caught: a ${pkg} that exists and throws`,
    `// must surface, not be swallowed into a silent fallback.`,
    `//`,
    `// Once your game ships its own composed ModePlugin, replace the whole block with an import`,
    `// of it (or name './dist/${name}.js#${pluginIdent(name)}' for the CLI to resolve).`,
    `import { fileURLToPath } from 'node:url';`,
    ``,
    `const plugin = await import('${pkg}').then(`,
    `  (m) => m.${modePlugin},`,
    `  (err) => {`,
    `    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;`,
    `    return '${mode}';`,
    `  },`,
    `);`,
    ``,
    `const scene = fileURLToPath(new URL('./${sceneRel}', import.meta.url));`,
    ``,
    `export default {`,
    `  name: '${name} plays for ${TICKS} ticks',`,
    `  scene,`,
    `  ticks: ${TICKS},`,
    `  seed: 1,`,
    `  // captureHistory lets assertInvariant re-check every tick, not just the last one.`,
    `  options: { plugin, captureHistory: true },`,
    `  input: \`${inputDoc(mode)
      .split('\n')
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .join('\\n')}\`,`,
    `  expect(result) {`,
    ...assertionsFor(mode),
    `  },`,
    `};`,
    ``,
  ].join('\n');
}

/**
 * The plugin declaration that makes the scaffolded game resolve its own plugin.
 *
 * Without this the game would start life running the *stock* mode by default — and because a
 * scaffolded scene marks its entities (`Player`, `Goal`) with tags no stock mode registers, the
 * CLI would rightly refuse to run it (`AEG-CLI-0020`). Writing the declaration makes the correct
 * configuration the default instead of a thing you have to know about, and it is the one line you
 * edit when the game grows its own composed plugin.
 */
function configDoc(name: string, mode: GameMode): string {
  return doc({
    plugin: mode,
    tests: [`./${name}.gametest.mjs`],
    $note: `Replace "plugin" with "./dist/${name}.js#${pluginIdent(name)}" once this game ships its own composed ModePlugin, and point "tests" at wherever its GameTests end up. 'aegis run/inspect/record/replay' resolve the plugin automatically for any scene in this directory, and 'aegis test' picks up the declared tests wherever they live.`,
  });
}

/** The conventional export name for a scaffolded game's future composed plugin. */
function pluginIdent(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter((p) => p.length > 0);
  const [first, ...rest] = parts;
  if (first === undefined) return 'gamePlugin';
  return first + rest.map((p) => p[0]!.toUpperCase() + p.slice(1)).join('') + 'Plugin';
}

/** Compute the artifacts for a scaffold kind. */
function artifactsFor(kind: Kind, name: string, mode: GameMode): Artifact[] {
  switch (kind) {
    case 'game':
      // No standalone `<name>.tilemap.json`. The scene embeds its level data under `resources`,
      // and **nothing loads a sibling tilemap file** — there is no scene → tilemap reference in
      // the format. Emitting one alongside the scene handed every new game a decoy: edit it, run,
      // and the run is byte-identical because the copy that matters is the inline one. `aegis
      // scaffold tilemap <name>` still writes a standalone document for the case where that is
      // what you actually want (authoring it, validating it, pasting it into `resources`).
      return [
        { rel: `${name}/aegis.json`, content: configDoc(name, mode) },
        { rel: `${name}/${name}.scene.json`, content: sceneDoc(name, mode) },
        { rel: `${name}/${name}.input`, content: inputDoc(mode) },
        { rel: `${name}/${name}.gametest.mjs`, content: testDoc(name, mode, `${name}.scene.json`) },
      ];
    case 'scene':
      return [{ rel: `${name}.scene.json`, content: sceneDoc(name, mode) }];
    case 'tilemap':
      return [{ rel: `${name}.tilemap.json`, content: tilemapDoc(name, mode) }];
    case 'prefab':
      return [{ rel: `${name}.prefab.json`, content: prefabDoc(name) }];
    case 'test':
      return [{ rel: `${name}.gametest.mjs`, content: testDoc(name, mode, `${name}.scene.json`) }];
  }
}

/**
 * Write every artifact or none of them.
 *
 * Writing one at a time and throwing on the first clash left a half-scaffolded directory that
 * could only be finished with `--force` — a scaffold that fails should leave nothing behind.
 */
function writeAll(baseDir: string, artifacts: readonly Artifact[], force: boolean): string[] {
  if (!force) {
    const clashes = artifacts.filter((a) => existsSync(resolve(baseDir, a.rel)));
    const [first] = clashes;
    if (first !== undefined) {
      throw new AegisCliError(
        CliCode.OutputExists,
        `Refusing to overwrite ${clashes.length} existing file(s): ${clashes.map((c) => c.rel).join(', ')}.`,
        {
          fix: 'Pass --force to overwrite, or choose a different name/--out. Nothing was written.',
          data: { paths: clashes.map((c) => c.rel) },
        },
      );
    }
  }
  const written: string[] = [];
  try {
    for (const artifact of artifacts) {
      const abs = resolve(baseDir, artifact.rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, artifact.content, 'utf8');
      written.push(artifact.rel);
    }
  } catch (err) {
    for (const rel of written) rmSync(resolve(baseDir, rel), { force: true });
    throw err;
  }
  return written;
}

/** `aegis scaffold` — generate a new game skeleton or single document from a template. */
export const scaffoldCommand: Command = {
  name: 'scaffold',
  summary: 'Generate a game, scene, tilemap, prefab or test from a template.',
  usage: USAGE,
  flags: { mode: 'value', out: 'value', force: 'boolean' },
  run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const kindArg = requirePositional(args, 0, 'kind', 'aegis scaffold <kind> <name>');
    // Validate first, then use the narrowed value — never name it `Kind` before it is proven one.
    const kind = KINDS.find((candidate) => candidate === kindArg);
    if (kind === undefined) {
      throw new AegisCliError(CliCode.InvalidChoice, `Unknown scaffold kind "${kindArg}".`, {
        fix: `Use one of: ${KINDS.join(', ')}.`,
        data: { received: kindArg, kinds: KINDS },
      });
    }
    const name = requirePositional(args, 1, 'name', 'aegis scaffold <kind> <name>');
    const mode = flagChoice(args, 'mode', GAME_MODES, 'platformer');
    const baseDir = resolvePath(io, flagString(args, 'out') ?? '.');

    const written = writeAll(baseDir, artifactsFor(kind, name, mode), flagBool(args, 'force'));

    if (flagBool(args, 'json')) {
      io.out(json({ kind, name, mode, out: flagString(args, 'out') ?? '.', files: written }));
    } else {
      const next =
        kind === 'game'
          ? [
              '',
              'next:',
              `  aegis validate ${name}/${name}.scene.json`,
              `  aegis run ${name}/${name}.scene.json --ticks ${TICKS} --input ${name}/${name}.input --ascii`,
              `  aegis test "${name}/*.gametest.mjs"`,
            ]
          : [];
      io.out(
        [
          `scaffolded ${kind} "${name}" (${mode}):`,
          ...written.map((f) => `  ${f}`),
          ...next,
          '',
        ].join('\n'),
      );
    }
    return Promise.resolve(Exit.Ok);
  },
};
