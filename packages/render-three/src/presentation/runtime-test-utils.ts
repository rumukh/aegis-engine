import { AnimationClip, DataTexture, Mesh, NumberKeyframeTrack } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Name } from '@aegis/core';
import type { Entity, World } from '@aegis/core';
import { FIXTURE_MANIFEST, fixtureGlb, fixtureWav } from '../testing/presentation-fixture.js';
import { loadPresentationAssets } from './assets.js';
import type { PresentationAssets } from './assets.js';
import type { PresentationFrame, PresentationRuntime } from './runtime.js';
import type { PresentationManifest } from './schema.js';

export function runtimeManifest(changes: Partial<PresentationManifest> = {}): PresentationManifest {
  return {
    aegis: 'presentation/1',
    assets: FIXTURE_MANIFEST.assets,
    materials: [
      ...(FIXTURE_MANIFEST.materials ?? []),
      { id: 'red', shading: 'unlit', color: '#ff0000' },
    ],
    ...changes,
  };
}

/** Real glTF geometry/animation decoding, with a Node image boundary and no WebGL or browser. */
export async function runtimeAssets(
  manifest: PresentationManifest,
  alterModel?: (gltf: GLTF) => void,
): Promise<PresentationAssets> {
  return loadPresentationAssets(
    { manifest, baseUrl: './assets/' },
    {
      loaders: {
        texture: async () => new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1),
        model: async () => {
          const gltf = await new GLTFLoader().parseAsync(fixtureGlb(), '');
          gltf.animations.push(
            new AnimationClip('lift', 1, [
              new NumberKeyframeTrack('fin.position[y]', [0, 1], [1.1, 2.1]),
            ]),
          );
          alterModel?.(gltf);
          return gltf;
        },
        audio: async () => Uint8Array.from(fixtureWav()).buffer,
      },
    },
  );
}

export function entityNamed(world: World, name: string): Entity {
  for (const view of world.query({ has: [Name] }).views())
    if (view.get(Name).value === name) return view.entity;
  throw new Error(`Test entity "${name}" is absent.`);
}

export function modelPart(runtime: PresentationRuntime, name: string, part = 'fin'): Mesh {
  const mesh = runtime.entity(name)?.object.getObjectByName(part);
  if (!(mesh instanceof Mesh)) throw new Error(`Test model "${name}" has no mesh "${part}".`);
  return mesh;
}

export function presentationFrame(
  tick: number,
  changes: Partial<PresentationFrame> = {},
): PresentationFrame {
  return { tick, tickRate: 60, generation: 0, paused: false, events: [], ...changes };
}
