/**
 * The isometric {@link ViewProvider}: turns grid world-state into the harness's two text views
 * (CHARTER principle 7) with no GPU.
 *
 * - {@link IsoViewProvider.semanticFrame} projects each on-grid entity through a classic 2:1
 *   isometric transform (`screenX = (x - y)·tileW/2`, `screenY = (x + y)·tileH/2`), sorts by
 *   depth `(x + y)` then entity handle, and reports position/screen/depth/tags/glyph. Occlusion
 *   and visible-fraction are omitted — a top-down 2:1 projection has no meaningful occluder — as
 *   the frozen `VisibleEntity` explicitly permits.
 * - {@link IsoViewProvider.asciiView} rasterises the whole nav grid to characters so an agent can
 *   *read the level*: walls, floor, the sealed door, switch/exit volumes and every actor, with a
 *   legend. This is the primary way an agent "sees" the iso grid.
 * @packageDocumentation
 */
import { Name, QUAT_IDENTITY, round, Transform } from '@aegis/core';
import type { GameMode, Vec3, World } from '@aegis/core';
import { Health, Trigger } from '@aegis/content';
import type { TriggerData } from '@aegis/content';
import type {
  AsciiView,
  SemanticFrame,
  ViewOptions,
  ViewProvider,
  VisibleEntity,
} from '@aegis/harness';
import { Blocking, Controlled, GridPosition, IsoCamera, NavGrid } from './components.js';
import type { NavGridData } from './components.js';

/** Default virtual viewport for the semantic frame. */
const DEFAULT_VIEWPORT = { width: 640, height: 480 } as const;
/** 2:1 isometric tile footprint in virtual pixels. */
const TILE_W = 32;
const TILE_H = 16;

/** Glyphs used by both views; kept in one place so the legend cannot drift from the raster. */
const GLYPH = {
  wall: '#',
  floor: '.',
  door: 'D',
  switch: 'K',
  exit: 'X',
  goal: 'X',
  player: '@',
  actor: 'G',
} as const;

/** The marker/tag component ids present on an entity (a tag serialises to an empty object). */
function markerTags(components: Record<string, unknown>): string[] {
  const tags: string[] = [];
  for (const [id, value] of Object.entries(components)) {
    if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) {
      tags.push(id);
    }
  }
  return tags.sort();
}

/** Isometric (2:1) projection producing the semantic frame and a top-down ASCII grid. */
export class IsoViewProvider implements ViewProvider {
  readonly mode: GameMode = 'iso';

  semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
    const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
    const snap = world.snapshot();
    const componentsByHandle = new Map<number, Record<string, unknown>>();
    for (const ent of snap.entities) {
      componentsByHandle.set(Number(ent.id), ent.components as Record<string, unknown>);
    }

    const entities: VisibleEntity[] = [];
    for (const view of world.query({ has: [GridPosition] }).views()) {
      const gp = view.get(GridPosition);
      const components = componentsByHandle.get(view.entity) ?? {};
      const world3: Vec3 = { x: gp.cellX, y: 0, z: gp.cellY };
      const screen = {
        x: (gp.cellX - gp.cellY) * (TILE_W / 2) + viewport.width / 2,
        y: (gp.cellX + gp.cellY) * (TILE_H / 2),
      };
      const name = world.get(view.entity, Name)?.value;
      const isPlayer = world.has(view.entity, Controlled);
      entities.push({
        entity: view.entity,
        ...(typeof name === 'string' ? { name } : {}),
        tags: markerTags(components),
        world: world3,
        screen,
        depth: gp.cellX + gp.cellY,
        layer: 0,
        glyph: isPlayer ? GLYPH.player : GLYPH.actor,
      });
    }
    entities.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.entity - b.entity));

    const followName =
      world
        .query({ has: [IsoCamera] })
        .first()
        ?.get(IsoCamera).target ?? '';
    const focus = followName === '' ? undefined : findByName(world, followName);
    const camPos: Vec3 = focus ? { x: focus.x, y: 8, z: focus.y } : { x: 0, y: 8, z: 0 };

    return {
      tick: world.tick,
      mode: 'iso',
      camera: {
        mode: 'iso',
        position: camPos,
        rotation: { ...QUAT_IDENTITY },
        projection: 'orthographic',
        orthoHeight: 16,
        viewport,
      },
      viewport,
      entities,
    };
  }

  asciiView(world: World, _options?: ViewOptions): AsciiView | undefined {
    const nav = world.getResource(NavGrid);
    if (nav === undefined || nav.width === 0) return undefined;

    const grid = baseGrid(nav);
    // Overlay dynamic obstacles (the sealed door), then trigger volumes, then actors — later
    // writes win, so an actor standing on a volume is drawn as the actor.
    for (const view of world.query({ has: [Blocking, GridPosition] }).views()) {
      const gp = view.get(GridPosition);
      put(grid, nav, gp.cellX, gp.cellY, GLYPH.door);
    }
    for (const view of world.query({ has: [Trigger, Transform] }).views()) {
      const trig = view.get(Trigger) as TriggerData;
      const p = view.get(Transform).position;
      put(grid, nav, round(p.x), round(p.y), triggerGlyph(trig.kind));
    }
    for (const view of world.query({ has: [GridPosition, Health] }).views()) {
      const gp = view.get(GridPosition);
      put(
        grid,
        nav,
        gp.cellX,
        gp.cellY,
        world.has(view.entity, Controlled) ? GLYPH.player : GLYPH.actor,
      );
    }

    return {
      tick: world.tick,
      width: nav.width,
      height: nav.height,
      rows: grid.map((row) => row.join('')),
      legend: {
        [GLYPH.wall]: 'solid wall (impassable)',
        [GLYPH.floor]: 'floor (passable)',
        [GLYPH.door]: 'sealed door (Blocking entity; removed when its switch is flipped)',
        [GLYPH.switch]: 'switch trigger volume',
        [GLYPH.exit]: 'exit / objective trigger volume',
        [GLYPH.player]: 'the controlled operative',
        [GLYPH.actor]: 'a non-controlled actor (e.g. the guard)',
      },
    };
  }
}

/** The trigger's ASCII glyph by kind. */
function triggerGlyph(kind: string): string {
  if (kind === 'switch') return GLYPH.switch;
  if (kind === 'exit' || kind === 'goal') return GLYPH.exit;
  return GLYPH.switch;
}

/** The base wall/floor character grid. */
function baseGrid(nav: NavGridData): string[][] {
  const rows: string[][] = [];
  for (let y = 0; y < nav.height; y++) {
    const row: string[] = [];
    for (let x = 0; x < nav.width; x++) {
      row.push(nav.blocked[y * nav.width + x] === true ? GLYPH.wall : GLYPH.floor);
    }
    rows.push(row);
  }
  return rows;
}

/** Write a glyph at a cell if in bounds. */
function put(grid: string[][], nav: NavGridData, x: number, y: number, glyph: string): void {
  if (x < 0 || y < 0 || x >= nav.width || y >= nav.height) return;
  grid[y]![x] = glyph;
}

/** Find an entity's grid cell by `Name`. */
function findByName(world: World, name: string): { x: number; y: number } | undefined {
  for (const view of world.query({ has: [GridPosition] }).views()) {
    if (world.get(view.entity, Name)?.value === name) {
      const gp = view.get(GridPosition);
      return { x: gp.cellX, y: gp.cellY };
    }
  }
  return undefined;
}
