import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Box3, DataTexture, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createSimulation, hashString } from '@aegis/core';
import type { World } from '@aegis/core';
import { Health, parseScene } from '@aegis/content';
import { bootstrapScene, parseInputScript } from '@aegis/harness';
import { FPS_COLLISION } from '@aegis/mode-fps';
import { fps } from '../poc/fps.mjs';
import { pocGames, pocStaticGames } from '../poc/poc-games.mjs';
import { createFpsAdapter } from '../packages/render-three/src/adapters/fps.js';
import { loadPresentationAssets } from '../packages/render-three/src/presentation/assets.js';
import type { PresentationAssets } from '../packages/render-three/src/presentation/assets.js';
import { preparePresentation } from '../packages/render-three/src/presentation/files.js';
import { validatePresentation } from '../packages/render-three/src/presentation/validate.js';
import { validatePresentationWorld } from '../packages/render-three/src/presentation/world.js';
import type { PresentationManifest } from '../packages/render-three/src/presentation/schema.js';
import {
  entityNamed,
  presentationFrame,
} from '../packages/render-three/src/presentation/runtime-test-utils.js';

// This is a composition test: neither the renderer nor a simulation game imports the other.
const source = fps.presentation;
const manifest = source.manifest;
const parsed = parseScene(readFileSync(fps.scene, 'utf8'));
assert.ok(parsed.ok && parsed.value);
const scene = parsed.value;
let assets: PresentationAssets;
const decodedModels = new Map<string, number>();

beforeAll(async () => {
  assert.ok(source.assetRoot);
  const readBytes = async (url: string): Promise<ArrayBuffer> =>
    Uint8Array.from(await readFile(fileURLToPath(url))).buffer;
  assets = await loadPresentationAssets(
    { manifest, baseUrl: pathToFileURL(source.assetRoot + sep).href },
    {
      loaders: {
        texture: async () => {
          throw new Error('Sector Breach declares embedded glTF maps, not standalone textures.');
        },
        model: async (url, manager) => {
          decodedModels.set(url, (decodedModels.get(url) ?? 0) + 1);
          // Replace only browser image decoding, retaining the real GLB and production loader.
          return new GLTFLoader(manager)
            .register(() => ({
              name: 'node-image-boundary',
              loadTexture: async () => new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1),
            }))
            .parseAsync(await readBytes(url), '');
        },
        audio: readBytes,
      },
    },
  );
});

afterAll(() => assets?.dispose());

function makeWorld(): World {
  return bootstrapScene(scene, { plugin: fps.plugin, seed: 'poc-fps' }).world;
}

function mounted(profile: PresentationManifest = manifest, world = makeWorld()) {
  const adapter = createFpsAdapter({ presentation: { manifest: profile, assets } });
  adapter.mount(world);
  const runtime = adapter.presentation;
  assert.ok(runtime);
  return { adapter, runtime, world };
}

function part(root: Object3D | undefined, name: string): Object3D {
  const node = root?.getObjectByName(name);
  assert.ok(node, `Missing authored node "${name}".`);
  return node;
}

function firstMesh(root: Object3D): Mesh {
  let mesh: Mesh | undefined;
  root.traverse((node) => {
    if (mesh === undefined && node instanceof Mesh) mesh = node;
  });
  assert.ok(mesh, 'Authored model must contain actual mesh geometry.');
  return mesh;
}

function inside(root: Object3D, min: readonly number[], max: readonly number[]): void {
  root.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(root, true);
  for (const [axis, index] of (['x', 'y', 'z'] as const).map(
    (axis, index) => [axis, index] as const,
  )) {
    expect(box.min[axis], `${root.name} minimum ${axis}`).toBeGreaterThanOrEqual(
      min[index]! - 1e-5,
    );
    expect(box.max[axis], `${root.name} maximum ${axis}`).toBeLessThanOrEqual(max[index]! + 1e-5);
  }
}

describe('Sector Breach playable presentation', () => {
  it('preflights the real closed asset graph and gives dev and static hosts the same profile', async () => {
    expect(validatePresentation(manifest).ok).toBe(true);
    expect(validatePresentationWorld(manifest, makeWorld()).ok).toBe(true);
    const prepared = preparePresentation(source, scene);
    expect(prepared.files.map((file) => file.path).sort()).toEqual([
      'airlock-ready.wav',
      'armor-impact.wav',
      'blast-door.glb',
      'breach-panel.glb',
      'coil-shot.wav',
      'extraction-pad.glb',
      'kestrel-security.glb',
      'orbital-facility.glb',
      'pressure-open.wav',
      'sentry-shutdown.wav',
      'station-air.wav',
      'suit-impact.wav',
      'vaultline-rifle.glb',
    ]);
    expect(prepared.totalBytes).toBeLessThan(3_500_000);
    expect(decodedModels.size).toBe(6);
    expect([...decodedModels.values()]).toEqual([1, 1, 1, 1, 1, 1]);
    const dev = (await pocGames()).find((game) => game.id === 'fps');
    const statik = (await pocStaticGames()).find((game) => game.id === 'fps');
    expect(dev?.presentation).toEqual(source);
    expect(statik?.presentation).toEqual(source);
    expect(dev?.scene).toEqual(scene);
    expect(statik?.sceneText).toBe(readFileSync(fps.scene, 'utf8'));
    expect(fps.scriptTicks).toBe(600);
    expect(manifest.audio?.cues?.map((cue) => cue.event)).toEqual([
      'weapon.fired',
      'door.opened',
      'enemy.damaged',
      'damage.taken',
      'enemy.killed',
      'level.completed',
      'player.died',
    ]);
  });

  it('mounts recognizable authored models at collider origins while retaining diagnostic geometry', () => {
    const { adapter, runtime, world } = mounted();
    try {
      const before = world.snapshot();
      const actor = runtime.entity('grunt')!;
      const panel = runtime.entity('button')!;
      const exit = runtime.entity('exit')!;
      expect(actor.object.name).toBe('Kestrel_K09_SecurityRobot');
      expect(panel.object.name).toBe('BreachLock_Panel');
      expect(exit.object.name).toBe('Extraction_Airlock07');
      expect(runtime.object('station')?.object.name).toBe('Sector09_OrbitalFacility');
      expect(runtime.object('weapon')?.object.name).toBe('Vaultline_V7_CoilRifle');
      expect(runtime.object('blast-door')?.object.name).toBe('PressureSeal_BlastDoor');
      expect(actor.root.position.toArray()).toEqual([0, 0, 17]);
      expect(panel.root.position.toArray()).toEqual([4, 0, 2]);
      expect(exit.root.position.toArray()).toEqual([0, 0, 19]);
      inside(actor.object, [-0.4, 0, 16.5], [0.4, 2, 17.5]);
      inside(panel.object, [3.7, 0.8, 1.4], [4.3, 2.4, 2.6]);
      const station = runtime.object('station')!.object;
      let mapped = 0;
      station.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          if (material instanceof MeshStandardMaterial && material.map !== null) mapped++;
        }
      });
      expect(mapped).toBeGreaterThan(8);
      expect(runtime.stats().resources.modelInstances).toBe(6);
      expect(runtime.stats().resources.pointLights).toBe(4);
      expect(runtime.stats().legacy.levelVisible).toBe(false);
      expect(runtime.stats().legacy.retainedMeshes).toBe(339);
      expect(runtime.stats().legacy.visibleMeshes).toBe(0);
      runtime.setDebugGeometry(true);
      adapter.sync(world);
      expect(runtime.stats().legacy.visibleMeshes).toBe(339);
      expect(adapter.scene.getObjectByName(`hitbox:${entityNamed(world, 'grunt')}`)?.visible).toBe(
        true,
      );
      expect(adapter.scene.getObjectByName('wall:5:12')).toBeDefined();
      runtime.setDebugGeometry(false);
      expect(runtime.stats().legacy.visibleMeshes).toBe(0);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
    }
  });

  it('plays every original winning tick with truthful clips, muzzle feedback and unchanged aim/oracles', () => {
    const { adapter, runtime, world } = mounted();
    try {
      const input = parseInputScript(readFileSync(fps.script, 'utf8'));
      assert.ok(input.ok && input.value);
      const frames = input.value.frames(600);
      const simulation = createSimulation({ world, schedule: fps.plugin.systems(), tickRate: 60 });
      const tickHashes: string[] = [];
      const door = part(runtime.object('blast-door')?.object, 'DoorLeaf');
      const status = part(runtime.entity('button')?.object, 'LockStatus');
      const indicator = part(runtime.entity('button')?.object, 'LockIndicator');
      const chest = part(runtime.entity('grunt')?.object, 'Chassis');
      const gun = runtime.object('weapon')!.object;
      const muzzle = part(gun, 'Muzzle');
      let cursor = 0;
      let peakEffects = 0;
      adapter.present(presentationFrame(0));
      for (let tick = 0; tick < 600; tick++) {
        simulation.step(frames[tick]);
        const hash = world.hash();
        tickHashes.push(hash);
        const history = world.events.history();
        const events = history.slice(cursor).map((event, index) => ({
          ...event,
          sequence: cursor + index,
        }));
        cursor = history.length;
        adapter.sync(world);
        const camera = adapter.camera.matrixWorld.toArray();
        adapter.present(presentationFrame(world.tick, { events }));
        expect(world.hash(), `render wrote world at tick ${world.tick}`).toBe(hash);
        expect(adapter.camera.matrixWorld.toArray()).toEqual(camera);
        peakEffects = Math.max(peakEffects, runtime.stats().effects.active);

        adapter.scene.updateMatrixWorld(true);
        gun.traverse((mesh) => {
          if (!(mesh instanceof Mesh)) return;
          const vertices = mesh.geometry.getAttribute('position');
          const point = new Vector3();
          for (let at = 0; at < vertices.count; at++) {
            point
              .fromBufferAttribute(vertices, at)
              .applyMatrix4(mesh.matrixWorld)
              .applyMatrix4(adapter.camera.matrixWorldInverse);
            assert.ok(point.y < -0.07, `Weapon covers aim at tick ${world.tick}.`);
            assert.ok(point.z < -0.1, `Weapon crosses near plane at tick ${world.tick}.`);
          }
        });
        inside(runtime.entity('grunt')!.object, [-0.4, 0, 16.5], [0.4, 2, 17.5]);
        if (world.tick === 21) {
          expect(door.position.y).toBeGreaterThan(0);
          expect(door.position.y).toBeLessThan(0.05);
          expect(world.getResource(FPS_COLLISION)?.cells[12 * 11 + 5]?.solid).toBe(false);
          const sparks: Mesh[] = [];
          adapter.foreground?.scene.traverse((node) => {
            if (node instanceof Mesh && node.name.startsWith('effect:burst:')) sparks.push(node);
          });
          expect(sparks).toHaveLength(6);
          const muzzleAt = muzzle.getWorldPosition(new Vector3());
          for (const spark of sparks)
            expect(spark.position.distanceTo(muzzleAt)).toBeLessThan(0.06);
        }
        if (world.tick === 32) {
          expect(status.scale.toArray()).toEqual([1, 1, 1]);
          expect(indicator.scale.toArray()).toEqual([0, 0, 0]);
        }
        if (world.tick === 44) expect(door.position.y).toBeCloseTo(2.45, 4);
        if (world.tick === 68) expect(door.position.y).toBeCloseTo(4.1, 5);
        if (world.tick === 131) {
          expect(part(runtime.entity('grunt')?.object, 'Arm_R').position.z).toBeGreaterThan(0.02);
        }
        if (world.tick === 193) {
          expect(chest.position.y).toBeGreaterThan(0.66);
          expect(chest.position.y).toBeLessThan(1.1);
        }
        if (world.tick >= 225) expect(chest.position.y).toBeCloseTo(0.66, 5);
      }
      expect(world.hash()).toBe('f86540b793f071a3');
      expect(hashString(tickHashes.join('|'))).toBe('1ce5508ff97c0b75');
      const count = (type: string) =>
        world.events.history().filter((event) => event.type === type).length;
      expect(count('weapon.fired')).toBe(5);
      expect(count('enemy.damaged')).toBe(2);
      expect(count('damage.taken')).toBe(1);
      expect(count('enemy.killed')).toBe(1);
      expect(count('level.completed')).toBe(1);
      expect(count('player.died')).toBe(0);
      expect(world.getOrThrow(entityNamed(world, 'player'), Health).current).toBe(90);
      expect(peakEffects).toBeGreaterThan(0);
      expect(peakEffects).toBeLessThanOrEqual(32);
      expect(runtime.stats().effects.active).toBe(0);
      expect(runtime.stats().dropped).toBe(0);
    } finally {
      adapter.dispose();
    }
  });

  it('reconstructs an already-dead sentry in a constant offline pose without replaying its death', () => {
    const world = makeWorld();
    world.getOrThrow(entityNamed(world, 'grunt'), Health).current = 0;
    const { adapter, runtime } = mounted(manifest, world);
    try {
      const before = world.snapshot();
      const chest = part(runtime.entity('grunt')?.object, 'Chassis');
      for (const tick of [0, 10, 33, 60, 600]) {
        adapter.present(presentationFrame(tick));
        expect(chest.position.y).toBeCloseTo(0.66, 5);
        expect(chest.position.z).toBeCloseTo(-0.02, 5);
      }
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
    }
  });

  it('preserves essential door/state clips in reduced motion and low quality without camera recoil', () => {
    const { adapter, runtime, world } = mounted();
    try {
      runtime.setQuality('low');
      runtime.setReducedMotion(true);
      adapter.present(presentationFrame(0));
      const before = world.snapshot();
      const camera = adapter.camera.matrixWorld.toArray();
      adapter.present(
        presentationFrame(21, {
          events: [
            { type: 'weapon.fired', tick: 20, sequence: 0 },
            { type: 'door.opened', tick: 20, sequence: 1 },
          ],
        }),
      );
      const wrapper = part(runtime.object('weapon')?.root, 'presentation:effect');
      expect(wrapper.position.toArray()).toEqual([0, 0, 0]);
      expect(adapter.scene.getObjectByName('presentation:effects')?.children).toHaveLength(0);
      expect(
        adapter.foreground?.scene.children.filter((node) => node.name.startsWith('effect:burst:')),
      ).toHaveLength(0);
      adapter.present(presentationFrame(68));
      expect(part(runtime.object('blast-door')?.object, 'DoorLeaf').position.y).toBeCloseTo(4.1, 5);
      expect(part(runtime.entity('button')?.object, 'LockStatus').scale.toArray()).toEqual([
        1, 1, 1,
      ]);
      expect(adapter.camera.matrixWorld.toArray()).toEqual(camera);
      expect(world.snapshot()).toEqual(before);
    } finally {
      adapter.dispose();
    }
  });

  it('remounts without duplicating models or disposing the shared geometry used by the next run', () => {
    const { adapter, runtime } = mounted();
    const weapon = runtime.object('weapon')!.object;
    const geometry = firstMesh(weapon).geometry;
    const release = vi.fn();
    geometry.addEventListener('dispose', release);
    try {
      adapter.present(
        presentationFrame(68, {
          events: [{ type: 'door.opened', tick: 20, sequence: 0 }],
        }),
      );
      const world = makeWorld();
      const hash = world.hash();
      adapter.mount(world);
      adapter.present(presentationFrame(0, { generation: 1 }));
      expect(part(runtime.object('blast-door')?.object, 'DoorLeaf').position.y).toBe(0);
      expect(part(runtime.entity('button')?.object, 'LockStatus').scale.toArray()).toEqual([
        0, 0, 0,
      ]);
      expect(runtime.stats().resources.modelInstances).toBe(6);
      expect(firstMesh(runtime.object('weapon')!.object).geometry).toBe(geometry);
      expect(release).not.toHaveBeenCalled();
      expect(world.hash()).toBe(hash);
      adapter.dispose();
      adapter.dispose();
      expect(assets.stats().modelInstances).toBe(0);
      expect(release).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
      geometry.removeEventListener('dispose', release);
    }
  });

  it('fails explicitly on a missing delivered rifle or a misspelled muzzle rather than drawing a fallback', () => {
    const absent = structuredClone(manifest);
    const rifle = absent.assets?.find((asset) => asset.id === 'rifle');
    assert.ok(rifle);
    rifle.src = 'missing-rifle.glb';
    expect(() => preparePresentation({ ...source, manifest: absent }, scene)).toThrow(
      /missing-rifle/,
    );
    const wrongNode = structuredClone(manifest);
    const flash = wrongNode.effects?.find(
      (effect) => effect.event === 'weapon.fired' && effect.kind === 'burst',
    );
    assert.ok(flash);
    flash.target.node = 'Muzzlle';
    expect(() => createFpsAdapter({ presentation: { manifest: wrongNode, assets } })).toThrow(
      /Unknown visual node "Muzzlle"/,
    );
    expect(assets.stats().modelInstances).toBe(0);
  });
});
