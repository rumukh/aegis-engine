/**
 * The harness must behave identically when the process holds **two copies of it**.
 *
 * A duplicated module instance is not exotic: two physical installs of the package, a `dist`
 * tree imported by file URL as well as by bare specifier, or (on Windows) two paths for one file
 * that differ only in the case of the drive letter. Any of those gives the process two copies of
 * every module in the graph.
 *
 * That used to split the verification records, which lived in module-level `WeakMap`s. The
 * assertions incremented one map and `runGameTest` read the other, so a test that asserted
 * correctly was reported as *"executed ZERO assertions"* — the harness telling the reader
 * something false about code that was fine. In the other direction the unknown-component guard
 * fell silent, because it treats "nothing known about this result" as "not my result".
 *
 * These tests build the second instance the portable way — copy the built `dist` tree and import
 * the copy — and drive one assertion from each instance across the *same* run. The negative
 * control is the first test: it asserts the two instances really are distinct, so a future change
 * that accidentally deduplicates them turns this file red rather than making it vacuous.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SceneFile } from '@aegis/content';
import {
  defineGameTest,
  expectSim,
  runGameTest,
  runScene,
  UnknownComponentError,
} from './index.js';
import type { GameTest } from './assert.js';
import { fakeMode } from './testing/fake-mode.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(PACKAGE_ROOT, 'dist');
/** Scratch inside the package (so bare `@aegis/*` specifiers still resolve) and gitignored. */
const SCRATCH = join(PACKAGE_ROOT, '.tmp');

/** A one-entity level: enough for `entityExists({ has: ['Player'] })` to mean something. */
const SCENE: SceneFile = {
  aegis: 'scene/1',
  name: 'two-instances',
  mode: 'platformer',
  seed: 'two-instances',
  entities: [
    {
      id: 'hero',
      tags: ['Player'],
      components: {
        Transform: { position: { x: 0, y: 0, z: 0 } },
        Velocity: { x: 0, y: 0, z: 0 },
        Health: { current: 1, max: 1 },
      },
    },
  ],
};

/** The second copy of the harness, and the scene both copies run. */
let other: typeof import('./index.js');
let copyDir: string;
let sceneDir: string;
let scenePath: string;

/**
 * Detach the copied `.js` files from their source maps.
 *
 * The maps are excluded from the copy (they resolve `../src/*.ts` relative to `dist`, which is not
 * beside the copy), but each `.js` still carries a `sourceMappingURL` comment — and Vite's
 * transform then logs a warning per file, which is exactly the sort of noise that trains a reader
 * to ignore the gate's output.
 */
function stripSourcemapRefs(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) stripSourcemapRefs(path);
    else if (entry.name.endsWith('.js')) {
      const source = readFileSync(path, 'utf8');
      const stripped = source
        .split('\n')
        .filter((line) => !line.startsWith('//# sourceMappingURL='))
        .join('\n');
      if (stripped !== source) writeFileSync(path, stripped, 'utf8');
    }
  }
}

beforeAll(async () => {
  if (!existsSync(join(DIST, 'index.js'))) {
    throw new Error(
      `[aegis] module-instances.test.ts needs the built harness at ${join(DIST, 'index.js')}. ` +
        `Run \`npm run build\` first (\`npm run verify\` builds before it tests).`,
    );
  }
  mkdirSync(SCRATCH, { recursive: true });
  copyDir = mkdtempSync(join(SCRATCH, 'harness-copy-'));
  cpSync(DIST, copyDir, { recursive: true, filter: (src) => !src.endsWith('.map') });
  stripSourcemapRefs(copyDir);
  other = (await import(pathToFileURL(join(copyDir, 'index.js')).href)) as typeof other;

  sceneDir = mkdtempSync(join(SCRATCH, 'harness-scene-'));
  scenePath = join(sceneDir, 'level.scene.json');
  writeFileSync(scenePath, JSON.stringify(SCENE), 'utf8');
});

afterAll(() => {
  rmSync(copyDir, { recursive: true, force: true });
  rmSync(sceneDir, { recursive: true, force: true });
});

/** A game test whose expectations are supplied by whichever copy of the harness `by` came from. */
function crossInstanceTest(by: typeof expectSim, name: string): GameTest {
  return defineGameTest({
    name,
    scene: scenePath,
    options: { plugin: fakeMode, captureHistory: true },
    ticks: 12,
    expect(result) {
      by(result).entityExists({ has: ['Player'] });
    },
  });
}

describe('two module instances of the harness', () => {
  it('really are two instances (negative control for every test below)', () => {
    // If this ever passes trivially — one instance — the cross-instance tests prove nothing.
    expect(other.expectSim).not.toBe(expectSim);
    expect(other.runGameTest).not.toBe(runGameTest);
  });

  it('agree on the verdict, whichever one supplied the assertions', async () => {
    const own = await runGameTest(crossInstanceTest(expectSim, 'assertions from this instance'));
    const cross = await runGameTest(
      crossInstanceTest(other.expectSim, 'assertions from the other instance'),
    );

    expect(own.passed).toBe(true);
    expect(own.assertions).toBe(1);
    // The defect: `cross` was `passed: false, assertions: 0`, failed with "executed ZERO
    // assertions", and told the reader their expect() callback had asserted nothing.
    expect(cross.error?.message ?? '').not.toContain('ZERO assertions');
    expect(cross.passed).toBe(true);
    expect(cross.assertions).toBe(1);
    expect(cross.checked).toEqual(own.checked);
  });

  it('still fail a test that genuinely asserts nothing, from either instance', async () => {
    const empty = defineGameTest({
      name: 'asserts nothing',
      scene: scenePath,
      options: { plugin: fakeMode },
      ticks: 12,
      expect() {},
    });
    for (const run of [runGameTest, other.runGameTest]) {
      const outcome = await run(empty);
      expect(outcome.passed).toBe(false);
      expect(outcome.assertions).toBe(0);
      expect(outcome.error?.message).toContain('ZERO assertions');
    }
  });

  it('keeps the unknown-component guard armed across instances', async () => {
    const result = await runScene(scenePath, { plugin: fakeMode, ticks: 4 });
    // The guard fell open here: the other instance knew nothing about this result, so it read a
    // typo'd component id as "not a run of mine" and let the query through.
    expect(() => other.expectSim(result).entityCount({ has: ['Playr'] }, 0)).toThrow(
      other.UnknownComponentError,
    );
    expect(() => expectSim(result).entityCount({ has: ['Playr'] }, 0)).toThrow(
      UnknownComponentError,
    );
  });

  it('records assertions on the result itself, not in module state', async () => {
    const result = await runScene(scenePath, { plugin: fakeMode, ticks: 4 });
    expectSim(result).entityExists({ has: ['Player'] });
    // Both copies read the same ledger because the ledger travels with the result.
    expect(other.assertionsFor(result)).toEqual([
      { kind: 'entityExists', detail: 'has:[Player] matches at least one entity' },
    ]);
    // …and it is invisible to anything that walks the object.
    expect(Object.keys(result)).not.toContain('assertions');
    expect(JSON.stringify({ ...result })).not.toContain('entityExists');
  });
});
