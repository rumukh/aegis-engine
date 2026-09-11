import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Box3,
  DataTexture,
  Mesh,
  Raycaster,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { LoadingManager, Object3D } from 'three';
import { Name, Transform } from '@aegis/core';
import { parseScene, Health } from '@aegis/content';
import { runScene } from '@aegis/harness';
import { GridPosition, NavGrid } from '@aegis/mode-iso';
import { serverVaultPlugin, SERVER_VAULT_SCRIPT, trajectoryDigest } from '@aegis/game-iso';
import { iso, vaultPresentation } from '../poc/iso.mjs';
import { createIsoAdapter } from '../packages/render-three/src/adapters/iso.js';
import { preparePresentation } from '../packages/render-three/src/presentation/files.js';
import { loadPresentationAssets } from '../packages/render-three/src/presentation/assets.js';
import type { PresentationAssets } from '../packages/render-three/src/presentation/assets.js';

const parsed = parseScene(readFileSync(resolve(iso.scene), 'utf8'));
if (!parsed.ok || parsed.value === undefined) throw new Error('The shipped vault scene is invalid');
const scene = parsed.value;
const prepared = preparePresentation(vaultPresentation, scene);
const files = new Map(prepared.files.map((file) => [file.path, file.source]));
let assets: PresentationAssets;

function file(name: string): Buffer {
  const path = files.get(name);
  if (path === undefined) throw new Error(`Required prepared vault asset is missing: ${name}`);
  return readFileSync(path);
}

/** Only image decoding is injected: geometry, clips, caching and disposal use the real platform. */
function texture(name: string): DataTexture {
  const bytes = file(name);
  if (name.endsWith('.svg')) {
    // Real SVG pixels are covered in the browser case, not falsely claimed by this Node boundary.
    return new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  }
  expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8);
  expect(bytes[25]).toBe(2);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const source = inflateSync(Buffer.concat(chunks));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    expect(source[row]).toBe(0);
    for (let x = 0; x < width; x++) {
      rgba.set(source.subarray(row + 1 + x * 3, row + 4 + x * 3), (y * width + x) * 4);
      rgba[(y * width + x) * 4 + 3] = 255;
    }
  }
  return new DataTexture(rgba, width, height, RGBAFormat, UnsignedByteType);
}

async function model(name: string, manager: LoadingManager) {
  const document = JSON.parse(file(name).toString()) as {
    buffers: { uri?: string }[];
    images: { uri: string }[];
    textures: { source: number }[];
  };
  const binary = Buffer.from(document.buffers[0]!.uri!.split(',')[1]!, 'base64');
  delete document.buffers[0]!.uri;
  const text = Buffer.from(JSON.stringify(document));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binaryLength = Math.ceil(binary.length / 4) * 4;
  const glb = new ArrayBuffer(28 + jsonLength + binaryLength);
  const bytes = Buffer.from(glb);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + jsonLength);
  text.copy(bytes, 20);
  bytes.writeUInt32LE(binaryLength, 20 + jsonLength);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(bytes, 28 + jsonLength);
  const loader = new GLTFLoader(manager);
  loader.register(() => ({
    name: 'VAULT_NODE_IMAGE_BOUNDARY',
    loadTexture: async (index: number) =>
      texture(document.images[document.textures[index]!.source]!.uri),
  }));
  return loader.parseAsync(glb, '');
}

beforeAll(async () => {
  const name = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
  assets = await loadPresentationAssets(
    {
      manifest: vaultPresentation.manifest,
      baseUrl: 'http://vault.invalid/assets/',
      files: [...files.keys()],
    },
    {
      loaders: {
        texture: async (url) => texture(name(url)),
        model: async (url, manager) => model(name(url), manager),
        audio: async (url) => Uint8Array.from(file(name(url))).buffer,
      },
    },
  );
});
afterAll(() => assets?.dispose());

describe('Server Vault real composition', () => {
  it('prepares the authored graph and instances only static models, with collision-derived coverage', () => {
    expect(prepared.files).toHaveLength(24);
    expect(prepared.totalBytes).toBeLessThan(1_500_000);
    const objects = vaultPresentation.manifest.objects!;
    const deck = objects.find((object) => object.id === 'walkable-deck')!;
    const walls = objects.find((object) => object.id === 'service-partitions')!;
    expect(deck.instances).toHaveLength(46);
    expect(walls.instances).toHaveLength(62);
    expect(deck.instances!.every((pose) => pose.position?.[1] === -0.04)).toBe(true);
    expect(walls.instances!.every((pose) => pose.position?.[1] === 0)).toBe(true);
    expect(vaultPresentation.manifest.legacy?.level).toBe(false);
    for (const object of objects) {
      if (object.instances === undefined || object.visual.kind !== 'model') continue;
      const instance = assets.instantiateModel(object.visual.mesh);
      expect(instance.clips).toHaveLength(0);
      instance.dispose();
    }
  });

  it('preserves all 960 authoritative snapshots while presenting patrol, firefight and held objective states', async () => {
    const run = await runScene(scene, {
      plugin: serverVaultPlugin,
      input: SERVER_VAULT_SCRIPT,
      ticks: 960,
      captureHistory: true,
    });
    expect(run.hash).toBe('cb0f07007ad8608a');
    expect(trajectoryDigest(run.tickHashes)).toBe('faab0cbc899d293c');
    const initial = await runScene(scene, { plugin: serverVaultPlugin, ticks: 0 });
    const mirror = initial.world;
    const adapter = createIsoAdapter({
      presentation: { manifest: vaultPresentation.manifest, assets },
    });
    try {
      adapter.mount(mirror);
      const events = run.events.history().map((event, sequence) => ({ ...event, sequence }));
      const states = new Set<string>();
      for (let tick = 0; tick < 960; tick++) {
        mirror.restore(run.at(tick).snapshot());
        const hash = mirror.hash();
        adapter.sync(mirror);
        adapter.present({
          tick: mirror.tick,
          tickRate: 60,
          generation: 0,
          paused: false,
          events: events.filter((event) => event.tick === tick),
        });
        expect(mirror.hash(), `presentation mutated tick ${tick}`).toBe(hash);
        if (tick === 24) {
          const guard = adapter.presentation!.entity('guard')!;
          expect(guard.state).toBe('move');
          expect(guard.root.position.x).toBe(1.5);
          expect(new Vector3(0, 0, 1).applyQuaternion(guard.root.quaternion).x).toBeCloseTo(1);
        }
        if (tick % 17 === 0) {
          for (const name of ['operative', 'guard']) {
            const actor = adapter.presentation!.entity(name)!;
            states.add(`${name}:${actor.state}`);
            expect(
              new Box3().setFromObject(actor.object, true).min.y,
              `${name} boot clearance at ${tick}`,
            ).toBeGreaterThan(-0.001);
          }
        }
        if ([0, 178, 322, 580].includes(tick)) {
          const nav = mirror.getResource(NavGrid)!;
          const drawn: Object3D[] = [];
          const owners = new Map<Object3D, { x: number; y: number }>();
          adapter.scene.updateMatrixWorld(true);
          adapter.scene.traverse((node) => {
            if (!(node instanceof Mesh)) return;
            for (let parent: Object3D | null = node; parent !== null; parent = parent.parent)
              if (!parent.visible) return;
            drawn.push(node);
          });
          for (const view of mirror.query({ has: [Name] }).views()) {
            const visual = adapter.presentation!.entity(view.get(Name).value);
            const grid = view.tryGet(GridPosition);
            const at = view.tryGet(Transform)?.position;
            if (visual && (grid !== undefined || at !== undefined))
              owners.set(visual.root, {
                x: grid?.cellX ?? at!.x,
                y: grid?.cellY ?? at!.y,
              });
          }
          const ray = new Raycaster();
          const inaccessible: string[] = [];
          for (let y = 0; y < nav.height; y++)
            for (let x = 0; x < nav.width; x++) {
              if (nav.blocked[y * nav.width + x]) continue;
              let visible = false;
              for (const dx of [0, -0.3, 0.3])
                for (const dz of [0, -0.3, 0.3]) {
                  const ndc = new Vector3(x + dx, 0, y + dz).project(adapter.camera);
                  if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
                  const picked = adapter.pick(ndc.x, ndc.y);
                  if (picked?.x !== x || picked.y !== y) continue;
                  ray.setFromCamera(new Vector2(ndc.x, ndc.y), adapter.camera);
                  const hit = ray.intersectObjects(drawn, false)[0];
                  if (hit === undefined) continue;
                  if (
                    hit.point.y < 0.03 &&
                    Math.round(hit.point.x) === x &&
                    Math.round(hit.point.z) === y
                  )
                    visible = true;
                  for (let node: Object3D | null = hit.object; node !== null; node = node.parent) {
                    const owner = owners.get(node);
                    if (owner?.x === x && owner.y === y) visible = true;
                  }
                }
              if (!visible) inaccessible.push(`${x},${y}`);
            }
          expect(inaccessible, `unreachable visible cells at ${tick}`).toEqual([]);
        }
      }
      expect(states).toEqual(
        new Set(['operative:idle', 'operative:move', 'guard:idle', 'guard:move', 'guard:dead']),
      );
      const runtime = adapter.presentation!;
      expect(
        runtime.entity('vault-door')!.object.getObjectByName('leaf-left')!.position.x,
      ).toBeCloseTo(-0.62);
      expect(
        runtime.entity('security-switch')!.object.getObjectByName('screen-active')!.scale.x,
      ).toBe(1);
      expect(
        runtime.entity('vault-exit')!.object.getObjectByName('uplink-column')!.scale.y,
      ).toBeCloseTo(1.3);
      expect(
        mirror
          .query({ has: [Name, Health] })
          .views()
          .find((view) => view.get(Name).value === 'operative')!
          .get(Health).current,
      ).toBe(20);
      const before = assets.stats();
      const restart = await runScene(scene, { plugin: serverVaultPlugin, ticks: 0 });
      for (let i = 0; i < 3; i++) adapter.mount(restart.world);
      expect(assets.stats()).toEqual(before);
      expect(runtime.stats().resources.batches).toBe(11);
    } finally {
      adapter.dispose();
      expect(assets.stats().modelInstances).toBe(0);
    }
  }, 120_000);
});
