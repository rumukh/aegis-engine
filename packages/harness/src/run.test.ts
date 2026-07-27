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
import type { Diagnostic, World } from '@aegis/core';
import {
  InvariantError,
  runScene,
  replayRecording,
  SelfReferentialCheckError,
  verifyReplay,
} from './run.js';
import { parseInputScript } from './input-script.js';
import type { ModePlugin } from './plugin.js';
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

  /**
   * F5(a): the message used to be eight words — `invariant "..." failed at tick 0` — with no
   * entity, no value, no threshold, no seed, no scene and no hint that the failing world can be
   * re-read. That is the entire debugging surface of a headless run.
   */
  it('the failure message carries scene, seed, the offending value and how to re-read it', async () => {
    let err: InvariantError | undefined;
    try {
      await runScene(level(), {
        plugin: fakeMode,
        ticks: 60,
        input: WINNING_INPUT,
        captureHistory: true,
        invariants: [
          {
            name: 'player stays left of x=3',
            check: (w) => {
              const x = playerTransform(w).position.x;
              return { ok: x < 3, actual: x, expected: '< 3', detail: `player at x=${x}` };
            },
          },
        ],
      });
    } catch (e) {
      err = e as InvariantError;
    }
    expect(err).toBeInstanceOf(InvariantError);
    expect(err!.message).toContain('scene "fake-level"');
    expect(err!.message).toContain('seed "poc-fake"');
    expect(err!.message).toContain(`tick ${err!.tick} of 60`);
    expect(err!.message).toContain('expected: "< 3"');
    expect(err!.message).toContain('actual  : 3.0666666666666664');
    expect(err!.message).toContain(`result.at(${err!.tick})`);
    expect(err!.context.historyAvailable).toBe(true);
  });

  it('summarises the world when the predicate returns a bare boolean', async () => {
    let err: InvariantError | undefined;
    try {
      await runScene(level(), {
        plugin: fakeMode,
        ticks: 60,
        input: WINNING_INPUT,
        invariants: [{ name: 'player stays left of x=3', check: leftOfThree }],
      });
    } catch (e) {
      err = e as InvariantError;
    }
    expect(err!.message).toContain('#0 "hero"');
    expect(err!.message).toContain('#1 "critter"');
    // History was off, so the message says how to get it rather than offering a broken hint.
    expect(err!.message).toContain('captureHistory: true');
  });

  /**
   * F2(c): a zero-tick run never steps, so the invariant loop never ran and *every* invariant
   * "held" — including `() => false`. A `ticks: 0` typo turned a whole safety suite green.
   * Both of these pass silently on the pre-fix code.
   */
  it('refuses a 0-tick run that declares live invariants, instead of passing them vacuously', async () => {
    await expect(
      runScene(level(), {
        plugin: fakeMode,
        ticks: 0,
        invariants: [{ name: 'always false', check: () => false }],
      }),
    ).rejects.toThrow(/never steps/);
  });

  it('refuses assertInvariant on a 0-tick run', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 0, captureHistory: true });
    expect(() => result.assertInvariant('always false', () => false)).toThrow(/no tick to check/);
  });

  /**
   * A check that **throws** produces no verdict at all, which is a different failure from a
   * violated invariant and used to be reported as neither: the bare inner error escaped the
   * per-tick loop with no invariant name and no tick, e.g.
   * `[aegis] QueryResult.one: expected exactly 1 match, got 0`.
   */
  it('names the invariant and the tick when the check itself throws', async () => {
    let err: Error | undefined;
    try {
      await runScene(level(), {
        plugin: fakeMode,
        ticks: 5,
        invariants: [
          {
            name: 'the boss is alive',
            check: (world) => world.query({ has: ['Enemy', 'Nonexistent'] }).one() !== undefined,
          },
        ],
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('the boss is alive');
    expect(err!.message).toContain('tick 0');
    expect(err!.message).toContain('expected exactly 1 match'); // the underlying cause
    expect(err!.message).toContain('broken check rather than a violated invariant');
  });

  it('names the invariant and the tick when an assertInvariant check throws', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 5, captureHistory: true });
    // Negative control first: a check that returns normally must not be reported as throwing.
    expect(() => result.assertInvariant('hero exists', (w) => w.entityCount > 0)).not.toThrow();
    expect(() =>
      result.assertInvariant('hero has a Nonexistent', (w) => {
        return w.query({ has: ['Nonexistent'] }).one() !== undefined;
      }),
    ).toThrow(/hero has a Nonexistent[\s\S]*broken check/);
  });
});

/**
 * `options.plugin` is typed, but the values that reach `runScene` at runtime often are not: a
 * discovered `*.gametest.mjs`, a scaffolded template, a JSON-ish literal. Those name their plugin
 * as a **spec string** because only the CLI can resolve one. Unguarded, the string reached
 * `plugin.components()` and produced `TypeError: plugin.components is not a function` — a message
 * that mentions neither plugins nor strings nor who resolves them (`AGENTS.md` §9 #6).
 */
describe('runScene — a plugin that is not a ModePlugin', () => {
  it('names the string and who can resolve it', async () => {
    await expect(
      runScene(level(), { plugin: 'platformer' as unknown as ModePlugin, ticks: 5 }),
    ).rejects.toThrow(/options\.plugin is not a ModePlugin[\s\S]*"platformer"[\s\S]*aegis\.json/);
  });

  it('names the missing methods for any other non-plugin value', async () => {
    await expect(
      runScene(level(), { plugin: { mode: 'platformer' } as unknown as ModePlugin, ticks: 5 }),
    ).rejects.toThrow(/components\(\), systems\(\) and view\(\)/);
  });

  // Negative control: the guard must accept the real thing, or every test above passes for the
  // wrong reason — a guard that rejects everything is not a guard.
  it('accepts a real ModePlugin', async () => {
    await expect(runScene(level(), { plugin: fakeMode, ticks: 5 })).resolves.toBeDefined();
  });
});

/**
 * L1 provenance: a check whose expected value is produced by the thing it is checking.
 *
 * `verifyReplay(result.recording(), result)` reads as the most thorough check the harness offers
 * and was the least. Measured before the guard existed:
 *
 * ```
 * verifyReplay(result.recording(), result) -> ok = true | problems = 0 | unverified = 0
 * ```
 *
 * Every comparison — final hash, tick count, the whole per-tick timeline — was a value against a
 * copy of itself, so it reported a clean, complete verification for any run whatsoever. This is
 * the same defect that reopened CHARTER §4.3 criterion 5 one level up: an instrument comparing two
 * live derivations of the same thing runs perfectly and measures nothing.
 */
describe('a verification cannot take its expected value from the run it verifies', () => {
  it('refuses a recording produced by the very result being verified', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 20, input: WINNING_INPUT });
    expect(() => verifyReplay(result.recording(), result)).toThrow(SelfReferentialCheckError);
    expect(() => verifyReplay(result.recording(), result)).toThrow(/every comparison below is a/);
  });

  /**
   * Negative control, and the boundary that makes the guard usable: a recording that has been
   * through a file is frozen evidence, not the run's own shadow. It must still verify — and must
   * still catch a changed run, or the guard has replaced one useless check with another.
   */
  it('still verifies a recording that has been serialised', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 20, input: WINNING_INPUT });
    const onDisk = parseRecording(serializeRecording(result.recording()));

    const clean = verifyReplay(onDisk, result);
    expect(clean.ok).toBe(true);
    expect(clean.problems).toEqual([]);

    const tampered = { ...onDisk, finalHash: '0000000000000000' };
    expect(verifyReplay(tampered, result).ok).toBe(false);
  });

  /**
   * The other legitimate shape: two **independent executions** of the same run description. Both
   * sides are live, but they are different computations, so the comparison can fail — that is
   * exactly the determinism property, and the guard must not confuse it with a tautology.
   */
  it('allows a recording checked against an independent re-execution', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 20, input: WINNING_INPUT });
    const verified = verifyReplay(result.recording(), result.replay());
    expect(verified.ok).toBe(true);
    expect(verified.problems).toEqual([]);
  });

  it('leaves the recording document itself untouched', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 20, input: WINNING_INPUT });
    const recording = result.recording();
    // The mark is a non-enumerable symbol: nothing that walks or serialises the document sees it,
    // which is why a round-trip through JSON legitimately clears it.
    expect(Object.keys(recording)).not.toContain('origin');
    expect(JSON.parse(serializeRecording(recording))).toEqual(
      JSON.parse(JSON.stringify(recording)),
    );
    expect(serializeRecording(recording)).not.toContain('origin');
  });
});

/**
 * F4: `forEachTick` clamps and the pointer/`aim` compilers `continue`, so a statement outside
 * `[0, ticks)` silently never happens. A 60-tick run with `press Jump @500` hashed identically to
 * a run with no input at all — the most likely authoring mistake in the DSL, and invisible.
 *
 * The identical hash is *correct*; what was missing is the tooling saying so. So the fix here is
 * the diagnostic channel, not a change in what the simulation does. Every test in this block sees
 * no diagnostics at all on the pre-fix code.
 */
describe('runScene — input the tick window would have swallowed', () => {
  it('still produces the same hash as no input at all — and now says so out loud', async () => {
    const seen: Diagnostic[] = [];
    const swallowed = await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: 'press Jump @500\nhold Right 200..300',
      onInputDiagnostics: (d) => seen.push(...d),
    });
    const idle = await runScene(level(), { plugin: fakeMode, ticks: 60 });

    // Behaviour is unchanged: the script really did nothing, and the hash proves it.
    expect(swallowed.hash).toBe(idle.hash);
    // What changed is that this is no longer silent.
    expect(seen).toHaveLength(2);
    expect(seen.every((d) => d.code === 'AEG-HARNESS-0009')).toBe(true);
    expect(seen.every((d) => d.severity === 'error')).toBe(true); // nothing applied at all
    expect(seen[0]!.message).toContain('"press Jump @500"');
    expect(seen[0]!.message).toContain('identical to one with the statement deleted');
    expect(seen[0]!.location?.line).toBe(1);
  });

  it('aborts only when the caller opts into strictInput', async () => {
    const ineffective = 'press Jump @500\nhold Right 200..300';
    await expect(
      runScene(level(), { plugin: fakeMode, ticks: 60, input: ineffective, strictInput: true }),
    ).rejects.toThrow(/AEG-HARNESS-0009/);
    // …and without it the run completes exactly as it always did.
    await expect(
      runScene(level(), { plugin: fakeMode, ticks: 60, input: ineffective }),
    ).resolves.toBeDefined();
  });

  it('reports clipped spans and fractional look deltas as warnings', async () => {
    const seen: Diagnostic[] = [];
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: 'hold Right 0..1000\nlook 90 0 50..70',
      onInputDiagnostics: (d) => seen.push(...d),
    });
    expect(result.tick).toBe(60);
    expect(seen.map((d) => d.code).sort()).toEqual(['AEG-HARNESS-0010', 'AEG-HARNESS-0011']);
    expect(seen.every((d) => d.severity === 'warning')).toBe(true);
    expect(seen.find((d) => d.code === 'AEG-HARNESS-0011')!.message).toContain('45° of 90° yaw');
  });

  it('does not treat a deliberate prefix run as an error, even under strictInput', async () => {
    // `aegis inspect --tick 20` on a longer script: the later statements are meant to be
    // inactive, so they are reported but never fatal.
    const seen: Diagnostic[] = [];
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 20,
      input: 'hold Right 0..60\npress Fire @1\npress Jump @300',
      strictInput: true,
      onInputDiagnostics: (d) => seen.push(...d),
    });
    expect(result.tick).toBe(20);
    expect(seen.map((d) => d.code).sort()).toEqual(['AEG-HARNESS-0009', 'AEG-HARNESS-0010']);
    expect(seen.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('says nothing for a script that fits its window', async () => {
    let called = 0;
    await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: WINNING_INPUT,
      onInputDiagnostics: () => called++,
    });
    expect(called).toBe(0);
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

  /**
   * F5(b): `ViewOptions.includeOffscreen` and `ViewOptions.ascii` were unreachable — `frame()`
   * forwarded only `viewport` and `ascii()` forwarded nothing at all, so two documented options
   * on the surface principle 7 depends on were dead API. Both of these fail on the pre-fix code.
   */
  it('forwards includeOffscreen and the ASCII grid size from the run options', async () => {
    const onScreenOnly = await runScene(level(), { plugin: fakeMode, ticks: 20 });
    const withOffscreen = await runScene(level(), {
      plugin: fakeMode,
      ticks: 20,
      view: {
        viewport: { width: 16, height: 9 },
        includeOffscreen: true,
        ascii: { width: 30, height: 6 },
      },
    });
    // The mode-owned platform sits at x = 20, far outside a 16px-wide viewport.
    expect(onScreenOnly.frame().entities.some((e) => e.tags.includes('Platform'))).toBe(false);
    expect(withOffscreen.frame().entities.some((e) => e.tags.includes('Platform'))).toBe(true);
    expect(withOffscreen.ascii()!.width).toBe(30);
    expect(withOffscreen.ascii()!.height).toBe(6);
  });

  it('accepts per-call view options that override the run options', async () => {
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 20,
      view: { viewport: { width: 16, height: 9 } },
    });
    expect(result.frame().entities.some((e) => e.tags.includes('Platform'))).toBe(false);
    expect(
      result
        .frame(undefined, { includeOffscreen: true })
        .entities.some((e) => e.tags.includes('Platform')),
    ).toBe(true);
    expect(result.ascii(undefined, { ascii: { width: 12, height: 4 } })!.width).toBe(12);
  });

  /**
   * F5(c): a semantic frame lists only what the camera sees, so entities are routinely dropped
   * with nothing in the data to say so — on `server-vault` the world holds 6 and the frame
   * reports 3, both mission objectives missing, reading as "the objective does not exist".
   */
  it('reports how many entities the frame left out', async () => {
    const result = await runScene(level(), {
      plugin: fakeMode,
      ticks: 20,
      view: { viewport: { width: 16, height: 9 } },
    });
    const frame = result.frame();
    expect(frame.totalEntities).toBe(result.world.entityCount);
    expect(frame.excludedEntities).toBe(frame.totalEntities! - frame.entities.length);
    expect(frame.excludedEntities).toBeGreaterThan(0); // the platform at x = 20 is off-screen
    // …and with nothing excluded the counts agree.
    const all = result.frame(undefined, { includeOffscreen: true });
    expect(all.excludedEntities).toBe(0);
  });

  it('fills each census field independently, never overwriting a provider that set one', async () => {
    // A provider that computes a more precise total (or a more precise exclusion count) keeps it;
    // the harness only fills the field that is missing.
    const world = (await runScene(level(), { plugin: fakeMode, ticks: 5 })).world;
    const base = fakeMode.view().semanticFrame(world);
    for (const provided of [
      { totalEntities: 99 },
      { excludedEntities: 7 },
      { totalEntities: 99, excludedEntities: 7 },
    ]) {
      const partial: ModePlugin = {
        ...fakeMode,
        view: () => ({
          ...fakeMode.view(),
          semanticFrame: (w) => ({ ...fakeMode.view().semanticFrame(w), ...provided }),
        }),
      };
      const frame = (await runScene(level(), { plugin: partial, ticks: 5 })).frame();
      expect(frame.totalEntities).toBe(provided.totalEntities ?? world.entityCount);
      expect(frame.excludedEntities).toBe(
        provided.excludedEntities ??
          (provided.totalEntities ?? world.entityCount) - base.entities.length,
      );
    }
  });

  it('reports ASCII cells where one entity covered another', async () => {
    // Drive the player onto the enemy's cell so the `@` glyph overwrites the `E`.
    const result = await runScene(level(), { plugin: fakeMode, ticks: 15, input: WINNING_INPUT });
    const view = result.ascii()!;
    const stacked = view.overlaps!.find((o) => o.glyphs.length > 1);
    expect(stacked).toBeDefined();
    expect(stacked!.glyphs).toContain('@'); // the player is the covering glyph
    expect(view.rows[stacked!.y]![stacked!.x]).toBe(stacked!.glyphs[stacked!.glyphs.length - 1]);
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

  /**
   * The recorder must never emit a script that is not the script that ran. The same defect class
   * as the re-sorting formatter: input supplied as explicit `InputFrame`s has no DSL spelling, so
   * `recording()` used to emit `input: ""` — a recording that replays as "no input" and then
   * blames the engine for non-determinism.
   */
  it('refuses to record a run driven by raw InputFrames rather than lying about its input', async () => {
    const frames = parseInputScript(WINNING_INPUT).value!.frames(60);
    const result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: frames });
    expect(() => result.recording()).toThrow(/cannot express/);
  });

  /**
   * F1 end to end: `recording()` serialises input through `formatInputScript`, which used to
   * re-sort commands even though the compiler resolves overlapping pointer writes as
   * last-source-order-wins. The recorded text was therefore a *different* script, and replaying
   * it failed the determinism check — against a perfectly deterministic engine. This fails on the
   * pre-fix code with "replay determinism check FAILED".
   */
  it('a recording of an order-sensitive script replays to the same hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-harness-'));
    const scenePath = join(dir, 'fake-level.scene.json');
    tmpDirs.push(dir);
    writeFileSync(scenePath, JSON.stringify(level()), 'utf8');

    // The audit's reproduction: two clicks on the same tick, the later one winning.
    const clash = 'click 9,1 @2\nclick 1,5 @2';
    const original = await runScene(scenePath, { plugin: fakeMode, ticks: 30, input: clash });
    const rec = original.recording();
    expect(rec.input).toBe(clash); // the recording IS the script that ran

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
