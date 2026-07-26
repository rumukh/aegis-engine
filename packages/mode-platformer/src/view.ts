/**
 * The platformer's {@link ViewProvider}: an orthographic side-on projection producing a
 * structured {@link SemanticFrame} and a readable {@link AsciiView}. The ASCII raster is how an
 * agent *sees* the level in text — it draws the solid/hazard tilemap first, then overlays
 * entities — so a failing playthrough can be eyeballed tick-by-tick without a GPU.
 * @packageDocumentation
 */
import { clamp, floor, Name, Transform } from '@aegis/core';
import type { Entity, GameMode, World } from '@aegis/core';
import { Health, Trigger } from '@aegis/content';
import type { TriggerData } from '@aegis/content';
import type {
  AsciiView,
  SemanticFrame,
  ViewOptions,
  ViewProvider,
  VisibleEntity,
} from '@aegis/harness';
import { KinematicPlatform, PlatformerCamera, PlatformerController } from './components.js';
import { emptyGrid, PlatformerCollision, rowOf } from './level.js';

const DEFAULT_VIEWPORT = { width: 160, height: 90 };
const ORTHO_HEIGHT = 12;

/** Marker component ids surfaced as tags on visible entities, in a fixed order. */
const TAG_IDS = ['PlatformerController', 'KinematicPlatform', 'Health', 'Trigger'] as const;

/** Glyph for an entity, by the strongest role it carries (fixed priority). */
function glyphFor(world: World, entity: Entity, trigger: TriggerData | undefined): string {
  if (world.has(entity, PlatformerController)) return '@';
  if (world.has(entity, KinematicPlatform)) return '=';
  if (trigger) return trigger.kind === 'hazard' ? '!' : 'G';
  if (world.has(entity, Health)) return 'E';
  return 'o';
}

/** Resolve the camera focus: the {@link PlatformerCamera} entity if present, else the player. */
function cameraFocus(world: World): { x: number; y: number; orthoHeight: number } {
  const cam = world.query({ has: [PlatformerCamera, Transform] }).first();
  if (cam) {
    const t = cam.get(Transform).position;
    return { x: t.x, y: t.y, orthoHeight: cam.get(PlatformerCamera).viewHeight };
  }
  const player = world.query({ has: [PlatformerController, Transform] }).first();
  const p = player ? player.get(Transform).position : { x: 0, y: 0 };
  return { x: p.x, y: p.y, orthoHeight: ORTHO_HEIGHT };
}

/** Build the platformer view provider. */
export function createPlatformerView(): ViewProvider {
  const provider: ViewProvider = {
    mode: 'platformer' as GameMode,

    semanticFrame(world: World, options?: ViewOptions): SemanticFrame {
      const viewport = options?.viewport ?? DEFAULT_VIEWPORT;
      const focus = cameraFocus(world);
      const scale = viewport.height / focus.orthoHeight;

      const entities: VisibleEntity[] = [];
      for (const view of world.query({ has: [Transform] }).views()) {
        const wp = view.get(Transform).position;
        const screen = {
          x: (wp.x - focus.x) * scale + viewport.width / 2,
          y: viewport.height / 2 - (wp.y - focus.y) * scale,
        };
        const onScreen =
          screen.x >= 0 && screen.x < viewport.width && screen.y >= 0 && screen.y < viewport.height;
        if (!onScreen && options?.includeOffscreen !== true) continue;

        const tags: string[] = [];
        for (const id of TAG_IDS) if (view.has(id)) tags.push(id);
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
        if (name !== undefined && name !== '') visible.name = name;
        entities.push(visible);
      }
      entities.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.entity - b.entity));

      return {
        tick: world.tick,
        mode: 'platformer',
        camera: {
          mode: 'platformer',
          position: { x: focus.x, y: focus.y, z: 10 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
          projection: 'orthographic',
          orthoHeight: focus.orthoHeight,
          viewport,
        },
        viewport,
        entities,
      };
    },

    asciiView(world: World, options?: ViewOptions): AsciiView | undefined {
      const grid = world.getResource(PlatformerCollision) ?? emptyGrid();
      const width = options?.ascii?.width ?? grid.width;
      const height = options?.ascii?.height ?? grid.height;
      if (width <= 0 || height <= 0) return undefined;

      const cells: string[][] = [];
      for (let r = 0; r < height; r++) cells.push(new Array<string>(width).fill('.'));

      // Tiles first (row 0 = top, matching the authored tilemap and world Y-up convention).
      for (let row = 0; row < grid.height && row < height; row++) {
        for (let col = 0; col < grid.width && col < width; col++) {
          const idx = row * grid.width + col;
          if (grid.hazard[idx] === true) cells[row]![col] = '^';
          else if (grid.solid[idx] === true) cells[row]![col] = '#';
        }
      }

      const draw = (x: number, y: number, glyph: string): void => {
        const col = clamp(floor(x), 0, width - 1);
        const row = clamp(rowOf(y, grid.height), 0, height - 1);
        cells[row]![col] = glyph;
      };
      // Entities on top, players last so they always win the cell.
      for (const view of world.query({ has: [Transform], none: [PlatformerController] }).views()) {
        const wp = view.get(Transform).position;
        draw(wp.x, wp.y, glyphFor(world, view.entity, view.tryGet(Trigger)));
      }
      for (const view of world.query({ has: [PlatformerController, Transform] }).views()) {
        const wp = view.get(Transform).position;
        draw(wp.x, wp.y, '@');
      }

      return {
        tick: world.tick,
        width,
        height,
        rows: cells.map((row) => row.join('')),
        legend: {
          '@': 'player',
          '=': 'moving platform',
          E: 'enemy / damageable body',
          G: 'goal / exit volume',
          '!': 'hazard volume',
          '#': 'solid tile',
          '^': 'hazard tile (spikes / lava)',
          o: 'other entity',
          '.': 'empty',
        },
      };
    },
  };
  return provider;
}
