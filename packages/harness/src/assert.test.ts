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
import {
  defineGameTest,
  expectSim,
  GameAssertionError,
  runGameTest,
  UnknownComponentError,
} from './assert.js';
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

/**
 * Golden state hashes of the fake-mode playthroughs below, pinned as **literals**.
 *
 * Two of the three sites live inside complete `defineGameTest({ … })` blocks, which makes them
 * copy-pasteable exemplars of how a game test is written — and `.hashEquals(result.hash)` is how
 * the hollow idiom reached `games/platformer` verbatim. Neither site was *broken* (the subject is
 * `runGameTest`, not the hash), but a template has to be exemplary, so they pin a literal the way a
 * real game does. The third site (the chaining test) does not have that shape, but pins the same
 * literal anyway so the repository demonstrates the bypass nowhere at all.
 *
 * `GOLDEN_HASH_POC_FAKE` covers two runs that are byte-identical: the chaining test takes its seed
 * from the scene, the game-test block states `seed: 'poc-fake'` explicitly, and `captureHistory`
 * does not touch world state. Derived from built output, twice each; re-derive if the fake mode's
 * physics or scene change on purpose.
 */
const GOLDEN_HASH_POC_FAKE = '2ea61fd1c4a8e734'; // level(), 60 ticks, seed 'poc-fake'
const GOLDEN_HASH_POC_PLATFORMER = '023df306ac80a566'; // level(), 60 ticks, seed 'poc-platformer'

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
        // The hash is not the subject here — the subject is that every assertion returns the same
        // object, so the chain composes — and any correct value would serve. It is nevertheless the
        // pinned literal, not `result.hash` and not an alias for it, so that the repository
        // contains **zero** demonstrations of a self-referential golden hash. The lint rule is
        // syntactic and `const h = r.hash` would slip past it; an author blocked by the rule greps
        // for how others satisfied it, and the premise of this whole fix is that comments do not
        // stop copying. This run is byte-identical to the `poc-fake` block below, so the same
        // constant covers both and pinning it here adds no coupling that file does not already have.
        .hashEquals(GOLDEN_HASH_POC_FAKE),
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
    // `Light` is registered (content ships it) but nothing in this level carries one — a real
    // "no matches" case, as opposed to a mistyped name, which is a different failure entirely.
    const msg = messageFrom(() => expectSim(result).entityExists({ has: ['Light'] }));
    expect(msg).toContain('has:[Light]');
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

  it('holds reports the seed, the tick and a census of the world it rejected', () => {
    const msg = messageFrom(() => expectSim(result).holds('never true', () => false));
    expect(msg).toContain('seed "poc-fake"'); // reproducible from the string alone
    expect(msg).toContain('tick 60');
    expect(msg).toContain('#0 "hero"'); // what was actually in the world
    expect(msg).toContain('#1 "critter"');
    expect(msg).toContain('{ ok, actual, expected }'); // how to make the next failure better
  });

  it('holds prints actual/expected when the predicate reports them', () => {
    const msg = messageFrom(() =>
      expectSim(result).holds('player reached x >= 500', (r) => {
        const x = r
          .query({ has: ['Player', 'Transform'] })
          .one()
          .get(Transform).position.x;
        return { ok: x >= 500, actual: x, expected: '>= 500', detail: 'player ran out of runway' };
      }),
    );
    expect(msg).toContain('expected: ">= 500"');
    expect(msg).toContain('actual  : 8');
    expect(msg).toContain('detail  : player ran out of runway');
  });
});

/**
 * F2(a): a component reference that resolves to nothing used to make its clause a silent no-op.
 * Demonstrated by the audit against a live world:
 *
 * ```
 * has:[Player]                 -> 1
 * has:[Player] none:[Player]   -> 0   (real ref: the exclusion works)
 * has:[Player] none:[Playr]    -> 1   (typo: the exclusion is silently DISABLED)
 * has:[Enmy]                   -> 0   (typo: matches nothing, no error)
 * ```
 *
 * So `entityCount({ has: ['Enmy'] }, 0)` — "assert every enemy is dead" — passed on any world,
 * including this one, where the enemy is alive at full health. Every one of these fails on the
 * pre-fix code (they all previously passed, which was the bug).
 */
describe('unresolvable component references are a loud error, not a silent no-op', () => {
  let result: SimResult;
  /** The same level, but the player never fires — so the enemy is ALIVE at full health. */
  let enemyAlive: SimResult;
  beforeAll(async () => {
    result = await runScene(level(), { plugin: fakeMode, ticks: 60, input: WINNING_INPUT });
    enemyAlive = await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: 'hold Right 0..60',
    });
  });

  it('"assert every enemy is dead" cannot pass on a world where the enemy is alive', () => {
    // The scenario verbatim: the enemy is alive at full health, and the assertion meant to catch
    // that is `entityCount({ has: ['Enmy'] }, 0)`. Pre-fix it passed, because the typo matched
    // nothing and 0 === 0.
    expect(enemyAlive.query({ has: ['Enemy'] }).count()).toBe(1); // it really is still there
    expect(enemyAlive.world.query({ has: ['Enmy'] }).count()).toBe(0); // …and the typo sees none
    expect(() => expectSim(enemyAlive).entityCount({ has: ['Enmy'] }, 0)).toThrow(
      UnknownComponentError,
    );
    // The correctly-spelled assertion is a real check, and it correctly fails on this world.
    expect(() => expectSim(enemyAlive).entityCount({ has: ['Enemy'] }, 0)).toThrow(
      GameAssertionError,
    );
  });

  it('rejects a typo in every clause — has, any and none', () => {
    // `none:` is the dangerous one: an unresolvable exclusion silently *widens* the result set,
    // so a filter written to narrow a query stops filtering with no sign that it stopped.
    expect(result.world.query({ has: ['Player'], none: ['Player'] }).count()).toBe(0);
    expect(result.world.query({ has: ['Player'], none: ['Playr'] }).count()).toBe(1); // widened
    expect(() => expectSim(result).entityCount({ has: ['Player'], none: ['Playr'] }, 1)).toThrow(
      UnknownComponentError,
    );
    expect(() => expectSim(result).entityExists({ has: ['Playr'] })).toThrow(UnknownComponentError);
    expect(() => expectSim(result).entityExists({ any: ['Playr', 'Enmy'] })).toThrow(
      UnknownComponentError,
    );
    // The real exclusion still works and still excludes.
    expect(() =>
      expectSim(result).entityCount({ has: ['Player'], none: ['Player'] }, 0),
    ).not.toThrow();
  });

  it('names the clause a typo appeared in, so a bad none: is not mistaken for a bad has:', () => {
    const msg = messageFrom(() =>
      expectSim(result).entityCount({ has: ['Player'], none: ['Playr'] }, 1),
    );
    expect(msg).toContain('"Playr" (in none:) is not a registered component');
    expect(msg).toContain('Did you mean "Player"?');
  });

  it('names the unknown component, the clause, a near-miss and the registered set', () => {
    const msg = messageFrom(() => expectSim(result).entityExists({ has: ['Enmy'] }));
    // The assertion still reads as itself failing, so existing tooling keeps working…
    expect(msg).toContain('Expected at least one entity matching has:[Enmy]');
    // …with the real reason attached.
    expect(msg).toContain('"Enmy" (in has:) is not a registered component');
    expect(msg).toContain('Did you mean "Enemy"?');
    expect(msg).toContain('Registered components:');
    expect(msg).toContain('Velocity'); // mode-contributed components are resolvable too
  });

  it('is an UnknownComponentError, which is still a GameAssertionError', () => {
    try {
      expectSim(result).entityExists({ has: ['Playr'] });
      throw new Error('expected the assertion to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownComponentError);
      expect(err).toBeInstanceOf(GameAssertionError);
    }
  });

  it('SimResult.query rejects the same typo, so `holds` predicates cannot hide one', () => {
    expect(() => result.query({ has: ['Playr'] })).toThrow(/Unresolvable component/);
    expect(() =>
      expectSim(result).holds(
        'typo inside a predicate',
        (r) => r.query({ has: ['Enmy'] }).count() === 0,
      ),
    ).toThrow(/Unresolvable component/);
  });

  it('resolves components a system attached without registering them', async () => {
    // `Triggered` is added at runtime by the fake mode's trigger system. It happens to be
    // registered too, but the world scan is the safety net for a mode that adds a component it
    // never declared in `components()` — that must not be reported as a typo.
    const withHistory = await runScene(level(), {
      plugin: fakeMode,
      ticks: 60,
      input: WINNING_INPUT,
    });
    expect(() => expectSim(withHistory).entityExists({ has: ['Triggered'] })).not.toThrow();
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
    const msg = messageFrom(() => expectSim(result).entityExists({ has: ['Light'] }));
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
          .hashEquals(GOLDEN_HASH_POC_FAKE); // pinned literal — see the constant
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

  it('reports how many assertions ran and what they checked', async () => {
    const test = defineGameTest({
      name: 'fake level: two checks',
      scene: scenePath,
      options: { plugin: fakeMode },
      ticks: 60,
      input: WINNING_INPUT,
      expect(result) {
        expectSim(result)
          .eventEmitted('level.completed', 1)
          .entityExists({ has: ['Player'] });
      },
    });
    const outcome = await runGameTest(test);
    expect(outcome.passed).toBe(true);
    expect(outcome.assertions).toBe(2);
    expect(outcome.checked).toEqual([
      'eventEmitted: "level.completed" emitted exactly 1×',
      'entityExists: has:[Player] matches at least one entity',
    ]);
  });

  /**
   * F2(b): `runGameTest` used to report `passed: true` whenever `expect` did not throw, so a test
   * that asserted nothing at all was indistinguishable from a proven playthrough. This fails on
   * the pre-fix code, where `passed` was `true`.
   */
  it('fails a game test whose expect block asserts nothing', async () => {
    const test = defineGameTest({
      name: 'fake level: verifies nothing',
      scene: scenePath,
      options: { plugin: fakeMode },
      ticks: 60,
      input: WINNING_INPUT,
      expect() {
        /* deliberately empty — the shape a half-written or short-circuited test takes */
      },
    });
    const outcome = await runGameTest(test);
    expect(outcome.passed).toBe(false);
    expect(outcome.assertions).toBe(0);
    expect(outcome.error?.message).toContain('ZERO assertions');
    expect(outcome.error?.message).toContain('cannot fail');
  });

  it('counts live invariants as real verification', async () => {
    const test = defineGameTest({
      name: 'fake level: invariant only',
      scene: scenePath,
      options: {
        plugin: fakeMode,
        invariants: [{ name: 'player stays above the death plane', check: (w) => playerY(w) > -4 }],
      },
      ticks: 60,
      input: WINNING_INPUT,
      expect() {
        /* nothing here, but the run itself checked something every tick */
      },
    });
    const outcome = await runGameTest(test);
    expect(outcome.passed).toBe(true);
    expect(outcome.assertions).toBe(1);
    expect(outcome.checked[0]).toContain('player stays above the death plane');
  });
});

/** The player's world-space y, for invariants. */
function playerY(world: World): number {
  return world
    .query({ has: ['Player', 'Transform'] })
    .one()
    .get(Transform).position.y;
}

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
          .hashEquals(GOLDEN_HASH_POC_PLATFORMER); // pinned literal — see the constant

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
