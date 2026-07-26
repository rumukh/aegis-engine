/**
 * A minimal but genuine fake {@link ModePlugin} the CLI's own tests run against.
 *
 * The three real `@aegis/mode-*` packages are being written in parallel with this CLI, so the
 * CLI cannot rely on them to prove its commands actually *execute* (not merely type-check). This
 * fake closes that gap exactly as the harness did before any mode existed: a tiny 2D
 * platformer-shaped mode — a player with `Velocity`, an enemy, a goal volume and a hazard volume
 * — wired through every seam a real mode uses:
 *
 * - `components()` contributes mode-owned component types (`Velocity`, `Player`, `Enemy`).
 * - `init(world)` does per-run setup (spawns a mode-owned platform) so the frozen
 *   `ModePlugin.init` hook is exercised end-to-end.
 * - `systems()` reads input, integrates physics with gravity + ground clamp, runs the shared
 *   `healthSystem`, maps generic `entity.died` to semantic `enemy.killed`/`player.died`, and does
 *   trigger detection with the shared `pointInTrigger`, emitting `level.completed`.
 * - `view()` provides an orthographic {@link ViewProvider} with a semantic frame and ASCII raster.
 *
 * Everything is deterministic: only `@aegis/core/math` helpers and plain arithmetic. It lives
 * under `src/` so it is type-checked like shipping code and becomes real evidence the commands
 * run, not a throwaway stub. It is intentionally not part of the public API.
 * @packageDocumentation
 */
import {
  clamp,
  createSchedule,
  defineComponent,
  defineTag,
  Name,
  round,
  sign,
  Transform,
} from '@aegis/core';
import type { ComponentType, Entity, Schedule, System, TickContext, World } from '@aegis/core';
import {
  ENTITY_DIED,
  Health,
  healthSystem,
  pointInTrigger,
  Trigger,
  Triggered,
} from '@aegis/content';
import type { EntityDiedEvent, TriggerData } from '@aegis/content';
import type {
  AsciiView,
  ModePlugin,
  SemanticFrame,
  ViewOptions,
  ViewProvider,
  VisibleEntity,
} from '@aegis/harness';

/** Simple velocity in world units per second. Mode-owned (not a core/content type). */
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

/** Semantic events the fake mode layers on the generic engine ones (two altitudes). */
export const ENEMY_KILLED = 'enemy.killed';
export const PLAYER_DIED = 'player.died';
export const LEVEL_COMPLETED = 'level.completed';

const MOVE_SPEED = 8;
const JUMP_SPEED = 16;
const GRAVITY = 30;
const MAX_FALL = 30;
const GROUND_Y = 0;

/** Read input and translate it into intent on the player. */
const inputSystem: System = {
  name: 'fake.input',
  phase: 'input',
  run({ world, input }: TickContext): void {
    const player = world.query({ has: [Player, Velocity] }).first();
    if (!player) return;
    const vel = world.get(player.entity, Velocity);
    if (!vel) return;

    const axis = input.axes['MoveX'];
    if (axis !== undefined) {
      vel.x = axis * MOVE_SPEED;
    } else {
      let dir = 0;
      if (input.actions['Right'] === true) dir += 1;
      if (input.actions['Left'] === true) dir -= 1;
      vel.x = dir * MOVE_SPEED;
    }

    if (input.pressed.includes('Jump')) vel.y = JUMP_SPEED;

    if (input.pressed.includes('Fire')) {
      const enemy = world.query({ has: [Enemy, Health] }).first();
      if (enemy) {
        const hp = world.get(enemy.entity, Health);
        if (hp) hp.current -= 1;
      }
    }

    const pointer = input.pointer;
    if (pointer && pointer.world && pointer.buttons.includes('primary')) {
      const t = world.get(player.entity, Transform);
      if (t) vel.x = sign(pointer.world.x - t.position.x) * MOVE_SPEED;
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

/** Map the generic `entity.died` to the fake mode's own semantic vocabulary. */
const combatSystem: System = {
  name: 'fake.combat',
  phase: 'postUpdate',
  after: ['content.health.death'],
  run({ world }: TickContext): void {
    for (const ev of world.events.ofType<EntityDiedEvent>(ENTITY_DIED)) {
      const { entity, name } = ev.data;
      if (world.has(entity, Enemy)) world.events.emit(ENEMY_KILLED, { entity, name });
      if (world.has(entity, Player)) world.events.emit(PLAYER_DIED, { entity, name });
    }
  },
};

/** Trigger detection: goal volumes complete the level, hazard volumes are lethal. */
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
        if (hp) hp.current = 0;
      }
      if (trig.once) world.add(view.entity, Triggered);
    }
  },
};

const DEFAULT_VIEWPORT = { width: 160, height: 90 };
const DEFAULT_ASCII = { width: 44, height: 12 };
const ORTHO_HEIGHT = 16;

const TAG_TYPES: readonly ComponentType<Record<string, never>>[] = [Player, Enemy, Platform];

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

/** The fake mode plugin the CLI tests run against. */
export const fakeMode: ModePlugin = {
  mode: 'platformer',

  components(): readonly ComponentType<unknown>[] {
    return [Velocity, Player, Enemy, Platform];
  },

  init(world: World): void {
    world.spawn(
      Name({ value: 'platform' }),
      Transform({ position: { x: 20, y: 3, z: 0 } }),
      Platform(),
    );
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
