/**
 * End-to-end runner tests, exercised against the in-repo {@link fakeMode} plugin.
 *
 * This is the load-bearing test in the whole session: the harness ships before any real
 * `@aegis/mode-*` exists, so without a fake mode the runner would only ever be type-checked.
 * Here it is genuinely *run* — scene load, component registration, `init`, the scheduled
 * systems, input compilation, live invariants, the view pipeline, replay and recording — so
 * the three mode sessions inherit a runner that provably works.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Transform } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import type { World } from '@aegis/core';
import { InvariantError, runScene, replayRecording } from './run.js';
import { parseRecording, serializeRecording } from './replay.js';
import { fakeMode, FakeReady } from './testing/fake-mode.js';

/**
 * A tiny completable level: the player runs right into a goal volume; an enemy sits within
 * range and is shot on tick 1. Proves goal detection, the death → semantic-event pipeline,
 * and survival (no player.died) all at once.
 */
function level(): SceneFile {
  return {
    aegis: 'scene/1',
    name: 'fake-level',
    mode: 'platformer',
    seed: 'poc-fake',
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
      {
        id: 'critter',
        tags: ['Enemy'],
        components: {
          Transform: { position: { x: 2, y: 0, z: 0 } },
          Health: { current: 1, max: 1 },
        },
      },
      {
        id: 'flag',
        components: {
          Transform: { position: { x: 5, y: 0, z: 0 } },
          Trigger: { kind: 'goal', shape: 'box', half: { x: 0.6, y: 1.5, z: 1 }, once: true },
        },
      },
    ],
  };
}

/** The winning playthrough: hold Right the whole way, fire once at the start. */
const WINNING_INPUT = 'hold Right 0..60\npress Fire @1';

describe('runScene — end to end against the fake mode', () => {
  it('runs the scheduled systems and completes the level exactly once', async () => {
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: WINNING_INPUT,
    });

    expect(result.tick).toBe(60);
    expect(result.events.count('level.completed')).toBe(1); // latched once
    expect(result.events.count('enemy.killed')).toBe(1); // Fire → entity.died → enemy.killed
    expect(result.events.count('entity.died')).toBe(1); // the generic, engine-level event
    expect(result.events.count('player.died')).toBe(0); // survived
  });

  it('runs plugin.init once before tick 0 (mode-owned setup is real)', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 5, input: WINNING_INPUT });
    const ready = result.world.getResource(FakeReady);
    expect(ready?.initialized).toBe(true);
    // init spawned a mode-owned platform entity that the scene never declared.
    expect(result.query({ has: ['Platform'] }).count()).toBe(1);
  });

  it('compiles input to the frames that actually drive the sim (player moved right)', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    const x = result
      .query({ has: ['Player', 'Transform'] })
      .one()
      .get(Transform).position.x;
    expect(x).toBeGreaterThan(5); // 8 u/s for ~1s carries the player past the flag at x=5
  });

  it('defaults an absent input to an idle run (no throw, no movement)', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 10 });
    const x = result
      .query({ has: ['Player', 'Transform'] })
      .one()
      .get(Transform).position.x;
    expect(x).toBe(0);
  });
});

describe('runScene — live invariants', () => {
  it('passes when the invariant holds every tick', async () => {
    await expect(
      runScene(level(), {
        plugin: fakeMode,
        ticks: 60,
        input: WINNING_INPUT,
        invariants: [{ name: 'player never falls through the floor', check: floorInvariant }],
      }),
    ).resolves.toBeDefined();
  });

  it('throws InvariantError naming the exact failing tick', async () => {
    let thrown: unknown;
    try {
      await runScene(level(), {
        plugin: fakeMode,
        ticks: 60,
        input: WINNING_INPUT,
        // Fails as soon as the player runs past x = 3.
        invariants: [{ name: 'player stays left of x=3', check: leftOfThree }],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvariantError);
    const err = thrown as InvariantError;
    expect(err.invariant).toBe('player stays left of x=3');
    expect(err.tick).toBeGreaterThan(0);
    expect(err.message).toContain('player stays left of x=3');
  });
});

describe('SimResult — history and the view pipeline', () => {
  it('at(tick) reconstructs an earlier world when captureHistory is on', async () => {
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 30,
      input: WINNING_INPUT,
      captureHistory: true,
    });
    const early = result
      .at(2)
      .query({ has: ['Player', 'Transform'] })
      .one()
      .get(Transform);
    const late = result
      .at(20)
      .query({ has: ['Player', 'Transform'] })
      .one()
      .get(Transform);
    expect(late.position.x).toBeGreaterThan(early.position.x);
  });

  it('at(tick) throws a helpful error when history was not captured', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 10, input: WINNING_INPUT });
    expect(() => result.at(2)).toThrow(/captureHistory/);
  });

  it('assertInvariant checks every captured tick', async () => {
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: WINNING_INPUT,
      captureHistory: true,
    });
    expect(() => result.assertInvariant('above the death plane', floorInvariant)).not.toThrow();
  });

  it('produces a semantic frame with the player projected and tagged', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 20, input: WINNING_INPUT });
    const frame = result.frame();
    expect(frame.mode).toBe('platformer');
    expect(frame.camera.projection).toBe('orthographic');
    const player = frame.entities.find((e) => e.tags.includes('Player'));
    expect(player).toBeDefined();
    expect(player!.glyph).toBe('@');
    // Frozen ruling: 2D modes leave occlusion undefined.
    expect(player!.occluded).toBeUndefined();
    expect(player!.visibleFraction).toBeUndefined();
  });

  it('rasterises a deterministic ASCII view containing the player glyph', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 20, input: WINNING_INPUT });
    const view = result.ascii();
    expect(view).toBeDefined();
    expect(view!.rows).toHaveLength(view!.height);
    expect(view!.rows.every((r) => r.length === view!.width)).toBe(true);
    expect(view!.rows.join('\n')).toContain('@');
  });
});

describe('replay & recording — determinism proof', () => {
  it('replay() reproduces a byte-identical hash', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    const replayed = result.replay();
    expect(replayed.hash).toBe(result.hash);
    expect(replayed.tickHashes).toEqual(result.tickHashes);
  });

  it('two independent runs of the same scene+input hash identically', async () => {
    const a = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    const b = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    expect(b.hash).toBe(a.hash);
  });

  it('a Recording serialises and parses round-trip (canonical, stable key order)', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    const rec = result.recording();
    const text = serializeRecording(rec);
    expect(text.endsWith('\n')).toBe(true);
    const parsed = parseRecording(text);
    expect(parsed).toEqual(rec);
    expect(serializeRecording(parsed)).toBe(text); // idempotent
  });

  it('replayRecording re-runs a recording from disk and asserts the pinned hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-harness-'));
    const scenePath = join(dir, 'fake-level.scene.json');
    tmpDirs.push(dir);
    writeFileSync(scenePath, JSON.stringify(level()), 'utf8');

    const original = await runScene(scenePath, {
      plugin: fakeMode,
      ticks: 60,
      input: WINNING_INPUT,
    });
    const rec = original.recording();
    expect(rec.scene).toBe(scenePath); // path recordings reference the file

    const replayed = await replayRecording(rec, { plugin: fakeMode, ticks: 0 });
    expect(replayed.hash).toBe(original.hash);
  });
});

// --- invariants used above -----------------------------------------------------------------

function playerTransform(world: World) {
  return world
    .query({ has: ['Player', 'Transform'] })
    .one()
    .get(Transform);
}
function floorInvariant(world: World): boolean {
  return playerTransform(world).position.y > -4;
}
function leftOfThree(world: World): boolean {
  return playerTransform(world).position.x < 3;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
