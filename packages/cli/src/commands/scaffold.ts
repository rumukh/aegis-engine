/**
 * `aegis scaffold` — generate a new game skeleton (or a single document) so an agent can go from
 * nothing to a runnable, valid game in one command (CHARTER principle 9).
 *
 * `scaffold game` writes a scene, a tilemap and a starter `GameTest` for the chosen mode; the
 * scene and tilemap validate immediately (they use only base components + tags), and the starter
 * test is wired to the mode's plugin so it runs as soon as that mode is implemented.
 * @packageDocumentation
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GAME_MODES } from '@aegis/core';
import type { GameMode } from '@aegis/core';
import { AegisCliError, CliCode, Exit } from '../errors.js';
import { json } from '../format.js';
import type { Command, CommandContext } from '../command.js';
import { flagBool, flagChoice, flagString, requirePositional, resolvePath } from './shared.js';

const KINDS = ['game', 'scene', 'tilemap', 'test', 'prefab'] as const;
type Kind = (typeof KINDS)[number];

const USAGE = [
  'aegis scaffold <kind> <name> [options]',
  '',
  '  <kind>            game | scene | tilemap | test | prefab.',
  '                    "game" writes a scene + tilemap + starter GameTest into <name>/.',
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

/** A minimal scene that validates against the base registry (Transform + Trigger + tags only). */
function sceneDoc(name: string, mode: GameMode): string {
  return doc({
    aegis: 'scene/1',
    name,
    mode,
    seed: 1,
    entities: [
      {
        id: 'player',
        tags: ['Player'],
        components: { Transform: { position: { x: 2, y: 0, z: 0 } } },
      },
      {
        id: 'goal',
        tags: ['Goal'],
        components: {
          Transform: { position: { x: 12, y: 0, z: 0 } },
          Trigger: { kind: 'goal', shape: 'box', half: { x: 1, y: 2, z: 1 }, once: true },
        },
      },
    ],
    meta: { description: `Scaffolded ${mode} scene — replace with your level.` },
  });
}

/** A small, well-formed collision tilemap. */
function tilemapDoc(name: string): string {
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

/** A starter GameTest, wired to the mode's plugin and referencing the scene cwd-independently. */
function testDoc(name: string, mode: GameMode, sceneRel: string): string {
  return [
    `// Starter GameTest for "${name}" (${mode}). Run with: aegis test`,
    `import { defineGameTest, expectSim } from '@aegis/harness';`,
    `import { ${mode}Plugin } from '@aegis/mode-${mode}';`,
    `import { fileURLToPath } from 'node:url';`,
    ``,
    `const scene = fileURLToPath(new URL('./${sceneRel}', import.meta.url));`,
    ``,
    `export default defineGameTest({`,
    `  name: '${name} spawns the player',`,
    `  scene,`,
    `  ticks: 120,`,
    `  options: { plugin: ${mode}Plugin },`,
    `  expect(result) {`,
    `    expectSim(result).entityExists({ has: ['Player'] });`,
    `  },`,
    `});`,
    ``,
  ].join('\n');
}

/** Compute the artifacts for a scaffold kind. */
function artifactsFor(kind: Kind, name: string, mode: GameMode): Artifact[] {
  switch (kind) {
    case 'game':
      return [
        { rel: `${name}/${name}.scene.json`, content: sceneDoc(name, mode) },
        { rel: `${name}/${name}.tilemap.json`, content: tilemapDoc(name) },
        { rel: `${name}/${name}.gametest.mjs`, content: testDoc(name, mode, `${name}.scene.json`) },
      ];
    case 'scene':
      return [{ rel: `${name}.scene.json`, content: sceneDoc(name, mode) }];
    case 'tilemap':
      return [{ rel: `${name}.tilemap.json`, content: tilemapDoc(name) }];
    case 'prefab':
      return [{ rel: `${name}.prefab.json`, content: prefabDoc(name) }];
    case 'test':
      return [{ rel: `${name}.gametest.mjs`, content: testDoc(name, mode, `${name}.scene.json`) }];
  }
}

/** `aegis scaffold` — generate a new game skeleton or single document from a template. */
export const scaffoldCommand: Command = {
  name: 'scaffold',
  summary: 'Generate a game, scene, tilemap, prefab or test from a template.',
  usage: USAGE,
  run(ctx: CommandContext): Promise<number> {
    const { args, io } = ctx;
    const kind = requirePositional(args, 0, 'kind', 'aegis scaffold <kind> <name>') as Kind;
    if (!(KINDS as readonly string[]).includes(kind)) {
      throw new AegisCliError(CliCode.InvalidChoice, `Unknown scaffold kind "${kind}".`, {
        fix: `Use one of: ${KINDS.join(', ')}.`,
        data: { received: kind, kinds: KINDS },
      });
    }
    const name = requirePositional(args, 1, 'name', 'aegis scaffold <kind> <name>');
    const mode = flagChoice(args, 'mode', GAME_MODES, 'platformer');
    const force = flagBool(args, 'force');
    const baseDir = resolvePath(io, flagString(args, 'out') ?? '.');

    const artifacts = artifactsFor(kind, name, mode);
    const written: string[] = [];
    for (const artifact of artifacts) {
      const abs = resolve(baseDir, artifact.rel);
      if (existsSync(abs) && !force) {
        throw new AegisCliError(CliCode.OutputExists, `Refusing to overwrite ${artifact.rel}.`, {
          fix: 'Pass --force to overwrite, or choose a different name/--out.',
          data: { path: artifact.rel },
        });
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, artifact.content, 'utf8');
      written.push(artifact.rel);
    }

    if (flagBool(args, 'json')) {
      io.out(json({ kind, name, mode, out: flagString(args, 'out') ?? '.', files: written }));
    } else {
      io.out(
        [`scaffolded ${kind} "${name}" (${mode}):`, ...written.map((f) => `  ${f}`), ''].join('\n'),
      );
    }
    return Promise.resolve(Exit.Ok);
  },
};
