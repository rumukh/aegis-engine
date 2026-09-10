import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Box3, DataTexture, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { createSimulation, hashString, Transform } from '@aegis/core';
import { parseScene, Trigger } from '@aegis/content';
import { bootstrapScene, parseInputScript } from '@aegis/harness';
import { KinematicPlatform, PlatformerCollision, TileCollider } from '@aegis/mode-platformer';
import { coyotePresentation, platformer } from '../poc/platformer.mjs';
import { pocGames, pocStaticGames } from '../poc/poc-games.mjs';
import { createPlatformerAdapter } from '../packages/render-three/src/adapters/platformer.js';
import { loadPresentationAssets } from '../packages/render-three/src/presentation/assets.js';
import type { PresentationAssets } from '../packages/render-three/src/presentation/assets.js';
import { preparePresentation } from '../packages/render-three/src/presentation/files.js';
import { validatePresentationWorld } from '../packages/render-three/src/presentation/world.js';
import {
  entityNamed,
  presentationFrame,
} from '../packages/render-three/src/presentation/runtime-test-utils.js';

const source = coyotePresentation;
const manifest = source.manifest;
const parsed = parseScene(readFileSync(platformer.scene, 'utf8'));
assert.ok(parsed.ok && parsed.value);
const scene = parsed.value;
let assets: PresentationAssets;
const sourceTextures: DataTexture[] = [];

beforeAll(async () => {
  assert.ok(source.assetRoot);
  assets = await loadPresentationAssets(
    { manifest, baseUrl: pathToFileURL(source.assetRoot + sep).href },
    {
      loaders: {
        // Only image decoding is a Node boundary. The real file graph, samplers and runtime run.
        texture: async () => {
          const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
          sourceTextures.push(texture);
          return texture;
        },
        audio: async (url) => Uint8Array.from(await readFile(new URL(url))).buffer,
        model: async () => {
          throw new Error('The Coyote Gap profile declares sprites, not a model decoder.');
        },
      },
    },
  );
});
afterAll(() => assets?.dispose());

function mounted() {
  const world = bootstrapScene(scene, { plugin: platformer.plugin }).world;
  const adapter = createPlatformerAdapter({ presentation: { manifest, assets } });
  adapter.mount(world);
  assert.ok(adapter.presentation);
  return { world, adapter, runtime: adapter.presentation };
}

function spriteMap(object: unknown) {
  assert.ok(object instanceof Mesh && object.material instanceof MeshBasicMaterial);
  return object.material.map;
}

describe('Coyote Gap real showcase composition', () => {
  it('gives both hosts the original scene, script, profile and closed local asset graph', async () => {
    const prepared = preparePresentation(source, scene);
    expect(prepared.files).toHaveLength(27);
    expect(prepared.totalBytes).toBeLessThan(2_000_000);
    expect(prepared.files.every((file) => file.provenance !== undefined)).toBe(true);
    expect(prepared.files.map((file) => file.path)).toContain('engineer.svg');
    expect(prepared.files.map((file) => file.path)).toContain('canyon-vista.jpg');
    expect(prepared.files.map((file) => file.path)).not.toContain('contact-sheet.html');
    const dev = (await pocGames()).find((game) => game.id === 'platformer');
    const statik = (await pocStaticGames()).find((game) => game.id === 'platformer');
    expect(dev?.presentation).toEqual(source);
    expect(statik?.presentation).toEqual(source);
    expect(dev?.scene).toEqual(scene);
    expect(statik?.sceneText).toBe(readFileSync(platformer.scene, 'utf8'));
    expect(dev?.script).toBe(readFileSync(platformer.script, 'utf8'));
    expect(platformer.scriptTicks).toBe(400);
    expect(manifest.audio?.cues?.map((cue) => cue.event)).toEqual([
      'player.jumped',
      'player.landed',
      'enemy.killed',
      'platform.boarded',
      'level.completed',
      'player.died',
    ]);
  });

  it('covers every solid cell once and keeps the actual feet, ferry deck and lethal volumes aligned', () => {
    const { world, adapter, runtime } = mounted();
    try {
      const before = world.snapshot();
      expect(validatePresentationWorld(manifest, world).ok).toBe(true);
      adapter.scene.updateMatrixWorld(true);
      const player = entityNamed(world, 'player');
      const sole = runtime
        .entity('player')!
        .object.localToWorld(new Vector3(80 / 160 - 0.5, 0.5 - 180 / 192, 0));
      expect(sole.x).toBe(2.5);
      expect(sole.y).toBeCloseTo(
        world.getOrThrow(player, Transform).position.y -
          world.getOrThrow(player, TileCollider).halfHeight,
        12,
      );
      const ferry = entityNamed(world, 'platform');
      const body = world.getOrThrow(ferry, KinematicPlatform);
      const position = world.getOrThrow(ferry, Transform).position;
      const deck = runtime.entity('platform')!.object;
      const left = deck.localToWorld(new Vector3(17 / 512 - 0.5, 0.5 - 35 / 192, 0));
      const right = deck.localToWorld(new Vector3(495 / 512 - 0.5, 0.5 - 35 / 192, 0));
      expect(left.x).toBeCloseTo(position.x - body.halfWidth, 12);
      expect(right.x).toBeCloseTo(position.x + body.halfWidth, 12);
      expect(left.y).toBeCloseTo(position.y + body.halfHeight, 12);
      for (const name of ['hazard-pit', 'hazard-lava']) {
        const entity = entityNamed(world, name);
        const trigger = world.getOrThrow(entity, Trigger);
        const center = world.getOrThrow(entity, Transform).position;
        const bounds = new Box3().setFromObject(runtime.entity(name)!.root);
        expect(bounds.min.x).toBeCloseTo(center.x - trigger.half.x, 12);
        expect(bounds.max.x).toBeCloseTo(center.x + trigger.half.x, 12);
        expect(bounds.min.y).toBeCloseTo(center.y - trigger.half.y, 12);
        expect(bounds.max.y).toBeCloseTo(center.y + trigger.half.y, 12);
      }

      const grid = world.getResource(PlatformerCollision)!;
      const covered = new Set<number>();
      for (const object of manifest.objects ?? []) {
        if (!object.id.startsWith('cliff-')) continue;
        const batch = runtime.object(object.id)!.root.children[0]!;
        assert.ok(batch instanceof InstancedMesh);
        for (let instance = 0; instance < batch.count; instance++) {
          const matrix = new Matrix4();
          batch.getMatrixAt(instance, matrix);
          matrix.premultiply(batch.matrixWorld);
          const point = new Vector3().setFromMatrixPosition(matrix);
          const col = Math.floor(point.x / grid.tileSize);
          const row = grid.height - 1 - Math.floor(point.y / grid.tileSize);
          const index = row * grid.width + col;
          expect(grid.solid[index], `decoration must not bridge empty cell ${col},${row}`).toBe(
            true,
          );
          expect(covered.has(index)).toBe(false);
          covered.add(index);
          expect(matrix.elements[0]).toBe(grid.tileSize);
          expect(matrix.elements[5]).toBe(grid.tileSize);
        }
      }
      expect(covered.size).toBe(180);
      expect(covered.size).toBe(grid.solid.filter(Boolean).length);
      expect(world.snapshot()).toEqual(before);
      runtime.setDebugGeometry(true);
      expect(adapter.scene.getObjectByName('level')!.visible).toBe(true);
      expect(runtime.stats().legacy.visibleMeshes).toBe(201);
      runtime.setDebugGeometry(false);
      expect(runtime.stats().legacy.visibleMeshes).toBe(0);
    } finally {
      adapter.dispose();
    }
  });

  it('samples the original 400-tick route even while manually paused, without changing any world hash', () => {
    const { world, adapter, runtime } = mounted();
    try {
      const input = parseInputScript(readFileSync(platformer.script, 'utf8'));
      assert.ok(input.ok && input.value);
      const frames = input.value.frames(400);
      const simulation = createSimulation({
        world,
        schedule: platformer.plugin.systems(),
        tickRate: 60,
      });
      const hashes: string[] = [];
      let cursor = 0;
      adapter.present(presentationFrame(0, { paused: true }));
      for (let tick = 1; tick <= 400; tick++) {
        simulation.step(frames[tick - 1]);
        const expected = world.hash();
        const history = world.events.history();
        const events = history.slice(cursor).map((event, index) => ({
          type: event.type,
          tick: event.tick,
          data: event.data,
          sequence: cursor + index,
        }));
        cursor = history.length;
        adapter.sync(world);
        adapter.present(presentationFrame(tick, { paused: true, events }));
        expect(world.hash(), `world mutation at tick ${tick}`).toBe(expected);
        hashes.push(expected);
        if (tick === 16) {
          expect(runtime.entity('player')!.state).toBe('move');
          expect(spriteMap(runtime.entity('player')!.object)).not.toBe(
            assets.texture('engineer', 'run-0'),
          );
        }
        if (tick === 158 || tick === 186) {
          expect(frames[tick - 1]!.actions['Right']).not.toBe(true);
          expect(runtime.entity('player')!.state).toBe('idle');
        }
        if (tick === 289 || tick === 322)
          expect(spriteMap(runtime.entity('player')!.object)).toBe(
            assets.texture('engineer', 'jump'),
          );
      }
      expect(world.hash()).toBe('d813e4e19db7444d');
      expect(hashString(hashes.join('|'))).toBe('79d373c4785825ca');
      expect(spriteMap(runtime.entity('goal')!.object)).toBe(assets.texture('beacon', 'active'));
      expect(spriteMap(runtime.entity('critter')!.object)).toBe(assets.texture('critter', 'clear'));
      expect(spriteMap(runtime.entity('player')!.object)).toBe(assets.texture('engineer', 'win-2'));
      expect(runtime.stats().effects.active).toBe(0);
    } finally {
      adapter.dispose();
    }
  });

  it('resets held event art and reuses borrowed textures without losing reduced-motion coverage', () => {
    const { world, adapter, runtime } = mounted();
    const releases = sourceTextures.map((texture) => vi.spyOn(texture, 'dispose'));
    try {
      adapter.present(
        presentationFrame(400, {
          events: [{ type: 'level.completed', tick: 328, sequence: 0 }],
        }),
      );
      expect(spriteMap(runtime.entity('goal')!.object)).toBe(assets.texture('beacon', 'active'));
      const loaded = assets.stats();
      adapter.mount(world);
      adapter.present(presentationFrame(0, { generation: 1, paused: true }));
      expect(assets.stats()).toEqual(loaded);
      expect(spriteMap(runtime.entity('goal')!.object)).toBe(assets.texture('beacon', 'idle'));
      expect(runtime.stats().effects.active).toBe(0);
      runtime.setReducedMotion(true);
      runtime.setQuality('low');
      adapter.resize(390, 844);
      adapter.sync(world);
      adapter.scene.updateMatrixWorld(true);
      const background = new Box3().setFromObject(runtime.object('canyon-vista')!.root);
      expect(background.min.x).toBeLessThan(adapter.camera.position.x + adapter.camera.left);
      expect(background.max.x).toBeGreaterThan(adapter.camera.position.x + adapter.camera.right);
      expect(background.min.y).toBeLessThan(adapter.camera.position.y + adapter.camera.bottom);
      expect(background.max.y).toBeGreaterThan(adapter.camera.position.y + adapter.camera.top);
      adapter.dispose();
      for (const dispose of releases) expect(dispose).not.toHaveBeenCalled();
      expect(assets.stats()).toEqual(loaded);
    } finally {
      adapter.dispose();
      releases.forEach((spy) => spy.mockRestore());
    }
  });
});
