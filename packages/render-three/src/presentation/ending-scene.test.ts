import { AnimationClip, Group, VectorKeyframeTrack } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { PresentationAssets } from './assets.js';
import type { WinEndingSpec } from './schema.js';
import { EndingScene } from './ending-scene.js';

export const ENDING_SPEC: WinEndingSpec = {
  model: 'ending',
  clip: 'departure',
  camera: { eye: 'eye', target: 'target' },
  title: 'Home',
  message: 'Evidence safe.',
};
export function endingLibrary() {
  const root = new Group();
  for (const name of ['eye', 'target', 'capsule']) {
    const node = new Group();
    node.name = name;
    root.add(node);
  }
  const clip = new AnimationClip('departure', 6, [
    new VectorKeyframeTrack('eye.position', [0, 6], [0, 1, 5, 0, 2, 10]),
    new VectorKeyframeTrack('capsule.position', [0, 6], [0, 0, 0, 12, 0, 0]),
  ]);
  const release = vi.fn();
  const library: PresentationAssets = {
    instantiateModel: () => ({ root, clips: [clip], dispose: release }),
    texture: vi.fn(),
    material: vi.fn(),
    audio: vi.fn(),
    dispose: vi.fn(),
    stats: () => ({
      textures: 0,
      materials: 0,
      geometries: 0,
      modelInstances: 1,
      audioBytes: 0,
      loadedFiles: 1,
    }),
  };
  return { root, clip, library, release };
}

describe('isolated authored ending scene', () => {
  it('samples actual object/camera tracks, clamps once and can restart after reaching the end', () => {
    const { library, root, release } = endingLibrary();
    const view = new EndingScene(library, ENDING_SPEC);
    expect(view.camera.position.toArray()).toEqual([0, 1, 5]);
    view.sample(3);
    expect(root.getObjectByName('capsule')!.position.toArray()).toEqual([6, 0, 0]);
    expect(view.camera.position.toArray()).toEqual([0, 1.5, 7.5]);
    view.sample(9);
    expect(root.getObjectByName('capsule')!.position.x).toBe(12);
    view.sample(0);
    expect(root.getObjectByName('capsule')!.position.x).toBe(0);
    expect(view.camera.position.toArray()).toEqual([0, 1, 5]);
    view.resize(800, 400);
    expect(view.camera.aspect).toBe(2);
    expect(() => view.sample(NaN)).toThrow('finite');
    view.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(view.scene.children).toHaveLength(0);
  });

  it('rejects missing clips, ambiguous/missing camera nodes and out-of-clip cues while releasing the instance', () => {
    for (const spec of [
      { ...ENDING_SPEC, clip: 'missing' },
      { ...ENDING_SPEC, camera: { eye: 'missing', target: 'target' } },
      { ...ENDING_SPEC, captions: [{ startSeconds: 0, endSeconds: 7, text: 'Too late' }] },
      { ...ENDING_SPEC, cues: [{ atSeconds: 6, event: 'presentation.late' }] },
    ]) {
      const { library, release } = endingLibrary();
      expect(() => new EndingScene(library, spec)).toThrow('[aegis:ending]');
      expect(release).toHaveBeenCalledOnce();
    }
    const { root, library, release } = endingLibrary();
    root.add(Object.assign(new Group(), { name: 'eye' }));
    expect(() => new EndingScene(library, ENDING_SPEC)).toThrow('exactly once');
    expect(release).toHaveBeenCalledOnce();
  });
});
