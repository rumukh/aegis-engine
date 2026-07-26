/**
 * Gameplay assertions and the portable game-test format.
 *
 * Two things are proven here. First, **failure-message quality** — the PM's explicit product
 * requirement: every assertion must say what was expected, what actually happened, and where, so
 * an agent debugging a headless run can act on the string alone. Each negative test asserts on
 * the *content* of the thrown message, not just that it threw. Second, **expressibility**: a
 * game test shaped exactly like the platformer PoC's `defineGameTest` block (docs/games/
 * platformer.md) runs against the fake mode with no API gaps.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSchedule, defineTag, makeEntity, Name, Transform } from '@aegis/core';
import type { ComponentType, System, TickContext, World } from '@aegis/core';
import type { SceneFile } from '@aegis/content';
import { defineGameTest, expectSim, GameAssertionError, runGameTest } from './assert.js';
import { runScene } from './run.js';
import type { SimResult } from './run.js';
import type { ModePlugin } from './plugin.js';
import type { AsciiView, SemanticFrame, ViewProvider } from './view.js';
import { fakeMode } from './testing/fake-mode.js';

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

const WINNING_INPUT = 'hold Right 0..60\npress Fire @1';

/** Capture the message of the GameAssertionError thrown by `fn`, failing if it does not throw. */
function messageFrom(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GameAssertionError);
    return (err as GameAssertionError).message;
  }
  throw new Error('expected the assertion to throw, but it did not');
}

describe('expectSim — a passing run chains fluently', () => {
  it('returns the same assertions object so calls can be chained', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    expect(() =>
      expectSim(result)
        .eventEmitted('level.completed', 1)
        .eventNotEmitted('player.died')
        .eventEmitted('enemy.killed', 1)
        .entityExists({ has: ['Player'] })
        .hashEquals(result.hash),
    ).not.toThrow();
  });
});

describe('expectSim — failure messages are actionable', () => {
  let result: SimResult;
  beforeAll(async () => {
    result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
  });

  it('eventEmitted prints expected, actual, the ticks it fired, and the full histogram', () => {
    const msg = messageFrom(() => expectSim(result).eventEmitted('level.completed', 2));
    expect(msg).toContain('Expected exactly 2');
    expect(msg).toContain('1 was emitted'); // the actual count
    expect(msg).toContain('Events that WERE emitted:');
    expect(msg).toContain('level.completed ×1'); // the histogram, so the agent sees reality
    expect(msg).toContain('enemy.killed ×1');
  });

  it('eventEmitted on a never-emitted type still shows what WAS emitted', () => {
    const msg = messageFrom(() => expectSim(result).eventEmitted('boss.defeated'));
    expect(msg).toContain('boss.defeated');
    expect(msg).toContain('Events that WERE emitted:');
    expect(msg).toContain('entity.died ×1');
  });

  it('eventNotEmitted names the ticks the event actually fired on', () => {
    const msg = messageFrom(() => expectSim(result).eventNotEmitted('enemy.killed'));
    expect(msg).toContain('Expected no "enemy.killed" event');
    expect(msg).toMatch(/tick/);
  });

  it('entityCount samples the matched entities by name, with CLI-style handles', () => {
    const msg = messageFrom(() => expectSim(result).entityCount({ has: ['Enemy'] }, 5));
    expect(msg).toContain('Expected exactly 5');
    expect(msg).toContain('has:[Enemy]');
    // The sole enemy is slot 1, generation 1: rendered index-dominant as `#1 "critter"`, never
    // as its raw packed handle. This is the regression guard for the CLI/harness handle vocabulary.
    expect(msg).toContain('#1 "critter"');
    const rawHandle = String(makeEntity(1, 1)); // 4294967297 — the pre-fix rendering
    expect(msg).not.toContain(rawHandle);
    expect(msg).not.toMatch(/#\d{5,}/); // no 10-digit packed handles leak into the message
  });

  it('entityExists lists what IS present when nothing matches', () => {
    const msg = messageFrom(() => expectSim(result).entityExists({ has: ['DoesNotExist'] }));
    expect(msg).toContain('has:[DoesNotExist]');
    expect(msg).toContain('Entities present:');
    expect(msg).toContain('hero');
  });

  it('hashEquals shows both the expected and the actual hash', () => {
    const msg = messageFrom(() => expectSim(result).hashEquals('0000000000000000'));
    expect(msg).toContain('0000000000000000');
    expect(msg).toContain(result.hash);
  });

  it('holds labels the failing predicate', () => {
    const msg = messageFrom(() =>
      expectSim(result).holds('player is still at the origin', (r) => {
        return (
          r
            .query({ has: ['Player', 'Transform'] })
            .one()
            .get(Transform).position.x === 0
        );
      }),
    );
    expect(msg).toContain('player is still at the origin');
  });
});

/**
 * Entity handles must read the same everywhere an agent looks. The CLI renders a packed handle
 * index-dominant (`#<index>`, and `#<index>@<gen>` once a slot has been reused); assertion
 * failure messages — the entire debugging surface for a headless run — must match that spelling
 * exactly, or `aegis inspect` and a failing assertion would name the same entity two different
 * ways in the same session. Core packs generation into the high 32 bits, so the pre-fix rendering
 * of slot 0 / generation 1 was the unreadable `#4294967296`.
 */
describe('entity handles render like the CLI (#index / #index@gen)', () => {
  it('renders a fresh entity index-dominant, not as its raw packed handle', async () => {
    const result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    const msg = messageFrom(() => expectSim(result).entityExists({ has: ['DoesNotExist'] }));
    // hero/critter/flag are slots 0/1/2 at generation 1 → `#0`/`#1`/`#2`, never `#4294967296`.
    expect(msg).toContain('#0 "hero"');
    expect(msg).not.toMatch(/#\d{5,}/);
    expect(msg).not.toContain(String(makeEntity(0, 1))); // 4294967296
  });

  it('shows the generation with @gen once a slot has been reused', async () => {
    // A tiny throwaway plugin that, once at tick 0, despawns the scene-authored "seed" entity and
    // spawns a replacement. The replacement reuses the freed slot at generation 2 — the only way
    // to drive `describeEntity`'s `@gen` branch through the fully public assertion path.
    const Seed: ComponentType<Record<string, never>> = defineTag('Seed');
    const Revenant: ComponentType<Record<string, never>> = defineTag('Revenant');

    const reuseSlot: System = {
      name: 'test.reuse-slot',
      run({ world }: TickContext): void {
        if (world.tick !== 0) return;
        const seed = world.query({ has: [Seed] }).first();
        if (seed) world.despawn(seed.entity);
        const revenant = world.spawn();
        world.add(revenant, Name, { value: 'revenant' });
        world.add(revenant, Revenant);
      },
    };

    const emptyView: ViewProvider = {
      mode: 'platformer',
      semanticFrame(world: World): SemanticFrame {
        return {
          tick: world.tick,
          mode: 'platformer',
          camera: {
            mode: 'platformer',
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            projection: 'orthographic',
            viewport: { width: 1, height: 1 },
          },
          viewport: { width: 1, height: 1 },
          entities: [],
        };
      },
      asciiView(): AsciiView | undefined {
        return undefined;
      },
    };

    const reusePlugin: ModePlugin = {
      mode: 'platformer',
      components: () => [Seed, Revenant],
      systems: () => {
        const s = createSchedule();
        s.add(reuseSlot);
        return s;
      },
      view: () => emptyView,
    };

    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'reuse',
      mode: 'platformer',
      seed: 'reuse',
      entities: [{ id: 'seed', tags: ['Seed'], components: { Transform: {} } }],
    };

    const result = await runScene(scene, { plugin: reusePlugin, ticks: 2 });
    const msg = messageFrom(() => expectSim(result).entityCount({ has: ['Revenant'] }, 5));
    // slot 0, generation 2 → `#0@2`, and its raw packed handle 8589934592 must NOT appear.
    expect(msg).toContain('#0@2 "revenant"');
    expect(msg).not.toContain(String(makeEntity(0, 2)));
  });
});

describe('defineGameTest / runGameTest — runner-agnostic playthroughs', () => {
  let dir: string;
  let scenePath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-harness-'));
    scenePath = join(dir, 'fake-level.scene.json');
    writeFileSync(scenePath, JSON.stringify(level()), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a passing game test and reports passed: true', async () => {
    const test = defineGameTest({
      name: 'fake level: run right, shoot the critter, reach the flag',
      scene: scenePath,
      options: { plugin: fakeMode, captureHistory: true },
      ticks: 60,
      seed: 'poc-fake',
      input: WINNING_INPUT,
      expect(result) {
        expectSim(result)
          .eventEmitted('level.completed', 1)
          .eventNotEmitted('player.died')
          .eventEmitted('enemy.killed', 1)
          .entityExists({ has: ['Player'] })
          .holds(
            'player ended past the flag',
            (r) =>
              r
                .query({ has: ['Player', 'Transform'] })
                .one()
                .get(Transform).position.x >= 5,
          )
          .hashEquals(result.hash);
        result.assertInvariant(
          'never fell out of the world',
          (w) =>
            w
              .query({ has: ['Player', 'Transform'] })
              .one()
              .get(Transform).position.y > -4,
        );
      },
    });
    const outcome = await runGameTest(test);
    expect(outcome.passed).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result).toBeDefined();
  });

  it('captures a failing game test as passed: false without throwing', async () => {
    const test = defineGameTest({
      name: 'fake level: impossible expectation',
      scene: scenePath,
      options: { plugin: fakeMode },
      ticks: 60,
      input: WINNING_INPUT,
      expect(result) {
        expectSim(result).eventEmitted('player.died', 1); // never happens on a winning run
      },
    });
    const outcome = await runGameTest(test);
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toBeInstanceOf(GameAssertionError);
    expect(outcome.result).toBeDefined(); // the run itself succeeded; only the assertion failed
  });
});

/**
 * Expressibility proof (acceptance criterion). This is the platformer PoC's `defineGameTest`
 * block from docs/games/platformer.md, structurally intact — the same assertion chain
 * (`eventEmitted` with an exact count, `eventNotEmitted`, `entityExists`, `holds` reading a
 * Transform via `query(...).one()`, `hashEquals`) and the same whole-timeline `assertInvariant`
 * calls. It type-checks and, wired to the fake mode, actually passes: no API gaps.
 */
describe('expressibility — the platformer defineGameTest block is fully expressible', () => {
  let dir: string;
  let scenePath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-harness-'));
    scenePath = join(dir, 'coyote-gap.scene.json');
    writeFileSync(scenePath, JSON.stringify(level()), 'utf8');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('is authorable and passes against a real (fake) mode plugin', async () => {
    const platformerPlugin = fakeMode; // stands in for @aegis/mode-platformer
    const test = defineGameTest({
      name: 'coyote gap (shape): reach the flag, survive, exactly once',
      scene: scenePath,
      options: { plugin: platformerPlugin, captureHistory: true },
      ticks: 60,
      seed: 'poc-platformer',
      input: `
        hold Right 0..60
        press Fire @1
      `,
      expect(result) {
        expectSim(result)
          .eventEmitted('level.completed', 1)
          .eventNotEmitted('player.died')
          .eventEmitted('enemy.killed', 1)
          .entityExists({ has: ['Player'] })
          .holds(
            'player ended on/past the goal',
            (r) =>
              r
                .query({ has: ['Player', 'Transform'] })
                .one()
                .get(Transform).position.x >= 5,
          )
          .hashEquals(result.hash);

        result.assertInvariant(
          'never fell out of the world',
          (w) =>
            w
              .query({ has: ['Player', 'Transform'] })
              .one()
              .get(Transform).position.y > -4,
        );
      },
    });
    const outcome = await runGameTest(test);
    expect(outcome.passed).toBe(true);
  });
});
