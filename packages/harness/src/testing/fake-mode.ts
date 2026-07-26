/**
 * A minimal but genuine fake {@link ModePlugin}, used only by the harness's own tests.
 *
 * The harness ships before any real `@aegis/mode-*` package exists, so it has nothing to run.
 * That is the single biggest risk in this session: a runner that only type-checks. This fake
 * mode closes that gap. It is a tiny 2D platformer-shaped mode — a player with `Velocity`, an
 * enemy, a goal volume and a hazard volume — wired through **every** seam the three real modes
 * will use:
 *
 * - `components()` contributes mode-owned component types (`Velocity`, `Player`, `Enemy`).
 * - `init(world)` does per-run setup (spawns a mode-owned platform, sets a resource) so the
 *   frozen `ModePlugin.init` hook is exercised end-to-end, not just declared.
 * - `systems()` reads **all** input channels (actions, pressed edges, axes, look, pointer),
 *   integrates physics with gravity + ground clamp, runs the shared `healthSystem`, maps the
 *   generic `entity.died` to semantic `enemy.killed` / `player.died` (the two-altitude rule),
 *   and does trigger detection with the shared `pointInTrigger`, emitting `level.completed`.
 * - `view()` provides a `ViewProvider` with an orthographic semantic frame and an ASCII raster.
 *
 * Everything is deterministic: no `Date`, no `Math.random`, no banned `Math.*` — only
 * `@aegis/core/math` helpers and plain arithmetic. This file lives under `src/` precisely so it
 * is type-checked and determinism-linted by the same rules as shipping code, making it real
 * evidence the runner works rather than a throwaway stub.
 *
 * It is intentionally **not** re-exported from the package index: it is test scaffolding, not
 * public API. Tests import it directly from `./testing/fake-mode.js`.
 * @packageDocumentation
 */
import {
  clamp,
  createSchedule,
  defineComponent,
  defineResource,
  defineTag,
  Name,
  round,
  sign,
  Transform,
} from '@aegis/core';
import type {
  ComponentType,
  Entity,
  GameMode,
  Schedule,
  System,
  TickContext,
  World,
} from '@aegis/core';
import {
  ENTITY_DIED,
  Health,
  pointInTrigger,
  healthSystem,
  Trigger,
  Triggered,
} from '@aegis/content';
import type { EntityDiedEvent, TriggerData } from '@aegis/content';
import type { ModePlugin } from '../plugin.js';
import type {
  AsciiView,
  SemanticFrame,
  ViewOptions,
  ViewProvider,
  VisibleEntity,
} from '../view.js';

/** Simple 2D-ish velocity, in world units per second. Mode-owned (not a core/content type). */
export interface VelocityData {
  x: number;
  y: number;
  z: number;
}

/** The fake mode's velocity component. */
export const Velocity: ComponentType<VelocityData> = defineComponent<VelocityData>({
  id: 'Velocity',
  defaults: () => ({ x: 0, y: 0, z: 0 }),
});

/** Marker: the player-controlled entity. */
export const Player: ComponentType<Record<string, never>> = defineTag('Player');
/** Marker: a killable enemy. */
export const Enemy: ComponentType<Record<string, never>> = defineTag('Enemy');
/** Marker: a mode-owned entity created in {@link fakeMode.init}. */
export const Platform: ComponentType<Record<string, never>> = defineTag('Platform');

/** Semantic events the fake mode layers on top of the generic engine ones (two altitudes). */
export const ENEMY_KILLED = 'enemy.killed';
export const PLAYER_DIED = 'player.died';
export const LEVEL_COMPLETED = 'level.completed';

/** Proof-of-`init` resource: flipped to `true` in {@link fakeMode.init}. */
export interface FakeReadyData {
  /** Set true once init has run. */
  initialized: boolean;
  /** The entity handle of the platform init spawned, or `-1` before init. */
  platform: number;
  /** Accumulated look-yaw, proving `look`/`aim` input reaches a system. */
  aimYaw: number;
}
export const FakeReady = defineResource<FakeReadyData>('fake.ready', () => ({
  initialized: false,
  platform: -1,
  aimYaw: 0,
}));

// --- tunables (deterministic constants) ----------------------------------------------------

const MOVE_SPEED = 8; // u/s
const JUMP_SPEED = 16; // u/s
const GRAVITY = 30; // u/s^2
const MAX_FALL = 30; // u/s
const GROUND_Y = 0; // world floor

// --- systems -------------------------------------------------------------------------------

/**
 * Read every input channel and translate it into intent on the player. Deliberately touches
 * actions, pressed edges, axes, look and pointer so the whole input pipeline is exercised.
 */
const inputSystem: System = {
  name: 'fake.input',
  phase: 'input',
  run({ world, input }: TickContext): void {
    const player = world.query({ has: [Player, Velocity] }).first();
    if (!player) return;
    const vel = world.get(player.entity, Velocity);
    if (!vel) return;

    // Horizontal: an analog axis wins if present, else digital left/right actions.
    const axis = input.axes['MoveX'];
    if (axis !== undefined) {
      vel.x = axis * MOVE_SPEED;
    } else {
      let dir = 0;
      if (input.actions['Right'] === true) dir += 1;
      if (input.actions['Left'] === true) dir -= 1;
      vel.x = dir * MOVE_SPEED;
    }

    // Jump: an edge press, not a hold — proves pressed[] is derived correctly.
    if (input.pressed.includes('Jump')) vel.y = JUMP_SPEED;

    // Fire: an edge press damages the nearest living enemy → drives the death pipeline.
    if (input.pressed.includes('Fire')) {
      const enemy = world.query({ has: [Enemy, Health], none: [] }).first();
      if (enemy) {
        const hp = world.get(enemy.entity, Health);
        if (hp) hp.current -= 1;
      }
    }

    // Pointer: a primary click nudges the player horizontally toward the clicked world x.
    const pointer = input.pointer;
    if (pointer && pointer.world && pointer.buttons.includes('primary')) {
      const t = world.get(player.entity, Transform);
      if (t) vel.x = sign(pointer.world.x - t.position.x) * MOVE_SPEED;
    }

    // Look/aim: accumulate yaw into a resource so look input has a deterministic, inspectable sink.
    if (input.look.dx !== 0 || input.look.dy !== 0) {
      const ready = world.getResource(FakeReady);
      if (ready) world.setResource(FakeReady, { ...ready, aimYaw: ready.aimYaw + input.look.dx });
    }
  },
};

/** Integrate velocity, apply gravity, clamp to the floor. Pure arithmetic — deterministic. */
const physicsSystem: System = {
  name: 'fake.physics',
  phase: 'physics',
  run({ world, dt }: TickContext): void {
    for (const view of world.query({ has: [Transform, Velocity] }).views()) {
      const t = view.get(Transform);
      const vel = view.get(Velocity);
      vel.y -= GRAVITY * dt;
      if (vel.y < -MAX_FALL) vel.y = -MAX_FALL;
      t.position.x += vel.x * dt;
      t.position.y += vel.y * dt;
      if (t.position.y <= GROUND_Y) {
        t.position.y = GROUND_Y;
        if (vel.y < 0) vel.y = 0;
      }
    }
  },
};

/**
 * Map the generic `entity.died` (emitted by the shared {@link healthSystem}) to the fake mode's
 * own semantic vocabulary. This is the game/mode half of the two-altitude event rule: the engine
 * says "entity N died"; the mode decides that means "an enemy was killed" or "the player died".
 */
const combatSystem: System = {
  name: 'fake.combat',
  phase: 'postUpdate',
  after: ['content.health.death'],
  run({ world }: TickContext): void {
    for (const ev of world.events.ofType<EntityDiedEvent>(ENTITY_DIED)) {
      const { entity, name } = ev.data;
      const handle = entity as unknown as Entity;
      if (world.has(handle, Enemy)) world.events.emit(ENEMY_KILLED, { entity, name });
      if (world.has(handle, Player)) world.events.emit(PLAYER_DIED, { entity, name });
    }
  },
};

/**
 * Trigger detection, mode-owned (the engine never runs it for you). Uses the shared pure
 * {@link pointInTrigger} test and emits the generic `trigger.entered`, then layers the semantic
 * `level.completed` for goal/exit volumes and lethal damage for hazard volumes.
 */
const triggerSystem: System = {
  name: 'fake.trigger',
  phase: 'postUpdate',
  run({ world, tick }: TickContext): void {
    const player = world.query({ has: [Player, Transform] }).first();
    if (!player) return;
    const ppos = world.get(player.entity, Transform);
    if (!ppos) return;

    for (const view of world.query({ has: [Trigger, Transform], none: [Triggered] }).views()) {
      const trig = view.get(Trigger);
      const center = view.get(Transform).position;
      if (!pointInTrigger(trig, center, ppos.position)) continue;

      world.events.emit('trigger.entered', { entity: view.entity, kind: trig.kind });
      if (trig.kind === 'goal' || trig.kind === 'exit') {
        world.events.emit(LEVEL_COMPLETED, { tick });
      }
      if (trig.kind === 'hazard') {
        const hp = world.get(player.entity, Health);
        if (hp) hp.current = 0; // lethal; healthSystem reports it next tick
      }
      if (trig.once) world.add(view.entity, Triggered);
    }
  },
};

// --- view provider -------------------------------------------------------------------------

const DEFAULT_VIEWPORT = { width: 160, height: 90 };
const DEFAULT_ASCII = { width: 44, height: 12 };
const ORTHO_HEIGHT = 16;

/** The set of marker components the view surfaces as tags, in a fixed order. */
const TAG_TYPES: readonly ComponentType<Record<string, never>>[] = [Player, Enemy, Platform];

/** Glyph for an entity, by the strongest marker it carries. */
function glyphFor(world: World, entity: Entity, trigger: TriggerData | undefined): string {
  if (world.has(entity, Player)) return '@';
  if (world.has(entity, Enemy)) return 'E';
  if (world.has(entity, Platform)) return '=';
  if (trigger) return trigger.kind === 'hazard' ? '^' : 'G';
  return '?';
}

const fakeView: ViewProvider = {
  mode: 'platformer',

  semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
    const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
    const scale = viewport.height / ORTHO_HEIGHT;
    const player = world.query({ has: [Player, Transform] }).first();
    const camX = player ? world.get(player.entity, Transform)!.position.x : 0;
    const camY = 0;

    const entities: VisibleEntity[] = [];
    for (const view of world.query({ has: [Transform] }).views()) {
      const wp = view.get(Transform).position;
      const screen = {
        x: (wp.x - camX) * scale + viewport.width / 2,
        y: viewport.height / 2 - (wp.y - camY) * scale,
      };
      const onScreen =
        screen.x >= 0 && screen.x < viewport.width && screen.y >= 0 && screen.y < viewport.height;
      if (!onScreen && !options?.includeOffscreen) continue;

      const tags: string[] = [];
      for (const type of TAG_TYPES) if (world.has(view.entity, type)) tags.push(type.id);
      const trigger = view.tryGet(Trigger);
      const name = view.tryGet(Name)?.value;

      const visible: VisibleEntity = {
        entity: view.entity,
        tags,
        world: wp,
        screen,
        depth: 10 - wp.z,
        layer: 0,
        glyph: glyphFor(world, view.entity, trigger),
      };
      if (name !== undefined) visible.name = name;
      entities.push(visible);
    }
    entities.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.entity - b.entity));

    return {
      tick: world.tick,
      mode: 'platformer',
      camera: {
        mode: 'platformer',
        position: { x: camX, y: camY, z: 10 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        projection: 'orthographic',
        orthoHeight: ORTHO_HEIGHT,
        viewport,
      },
      viewport,
      entities,
    };
  },

  asciiView(world: World, options?: ViewOptions): AsciiView | undefined {
    const width = options?.ascii?.width ?? DEFAULT_ASCII.width;
    const height = options?.ascii?.height ?? DEFAULT_ASCII.height;
    const grid: string[][] = [];
    for (let r = 0; r < height; r++) grid.push(new Array<string>(width).fill('.'));

    // Draw triggers first, then platforms/enemies, then the player on top (fixed priority).
    const draw = (col: number, row: number, glyph: string): void => {
      const c = clamp(round(col), 0, width - 1);
      const rr = clamp(round(row), 0, height - 1);
      grid[rr]![c] = glyph;
    };
    for (const view of world.query({ has: [Trigger, Transform] }).views()) {
      const wp = view.get(Transform).position;
      draw(wp.x, height - 1 - wp.y, glyphFor(world, view.entity, view.get(Trigger)));
    }
    for (const view of world.query({ has: [Transform], none: [Player] }).views()) {
      if (view.has(Trigger)) continue;
      const wp = view.get(Transform).position;
      draw(wp.x, height - 1 - wp.y, glyphFor(world, view.entity, undefined));
    }
    const player = world.query({ has: [Player, Transform] }).first();
    if (player) {
      const wp = world.get(player.entity, Transform)!.position;
      draw(wp.x, height - 1 - wp.y, '@');
    }

    return {
      tick: world.tick,
      width,
      height,
      rows: grid.map((row) => row.join('')),
      legend: {
        '@': 'player',
        E: 'enemy',
        '=': 'platform',
        G: 'goal / exit volume',
        '^': 'hazard volume',
        '.': 'empty',
      },
    };
  },
};

// --- the plugin ----------------------------------------------------------------------------

/** The fake mode plugin the harness tests run against. */
export const fakeMode: ModePlugin = {
  mode: 'platformer' as GameMode,

  components(): readonly ComponentType<unknown>[] {
    return [Velocity, Player, Enemy, Platform];
  },

  init(world: World): void {
    // Per-run setup: spawn a mode-owned platform entity and record it in a resource. This proves
    // init runs exactly once, after the scene is instantiated and before tick 0.
    const platform = world.spawn(
      Name({ value: 'platform' }),
      Transform({ position: { x: 20, y: 3, z: 0 } }),
      Platform(),
    );
    world.setResource(FakeReady, { initialized: true, platform, aimYaw: 0 });
  },

  systems(): Schedule {
    return createSchedule().addAll([
      inputSystem,
      physicsSystem,
      healthSystem,
      combatSystem,
      triggerSystem,
    ]);
  },

  view(): ViewProvider {
    return fakeView;
  },
};
