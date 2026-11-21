import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createSimulation, Transform } from '@aegis/core';
import { parseScene } from '@aegis/content';
import { bootstrapScene, parseInputScript } from '@aegis/harness';
import { HorrorThreat, nullMeridianPlugin } from '../games/horror/src/index.js';
import { horror } from '../poc/horror.mjs';
import { createRenderAdapter } from '../packages/render-three/src/adapters/index.js';
import { loadPresentationAssets } from '../packages/render-three/src/presentation/assets.js';
import type { PresentationManifest } from '../packages/render-three/src/presentation/schema.js';
import {
  approachHashes,
  clipRotation,
  expectApproachPose,
  loadWarden,
  wardenJoints,
  wardenModel,
} from './support/warden-approach.js';

async function mission(file: string, ticks: number) {
  const scene = parseScene(readFileSync(horror.scene, 'utf8')).value;
  const script = parseInputScript(readFileSync(file, 'utf8')).value;
  assert.ok(scene && script);
  const frames = script.frames(ticks);
  const { world, entities } = bootstrapScene(scene, { plugin: nullMeridianPlugin });
  const simulation = createSimulation({
    world,
    tickRate: 60,
    schedule: nullMeridianPlugin.systems(),
    input: { frameFor: (t) => frames[t]! },
  });
  // Mount the shipping responder binding and warning effect; skip unrelated scenery and sound IO.
  const shipped = horror.presentation.manifest;
  const manifest: PresentationManifest = {
    aegis: 'presentation/1',
    assets: shipped.assets?.filter((a) => a.id === 'responder'),
    entities: shipped.entities?.filter(
      ({ target }) => 'name' in target && target.name === 'responder',
    ),
    effects: shipped.effects?.filter((e) => e.event === 'horror.threat.warning'),
  };
  const model = await loadWarden();
  const assets = await loadPresentationAssets(
    { manifest, baseUrl: './' },
    {
      loaders: {
        model: async (url) => {
          expect(new URL(url).pathname).toBe(`/${wardenModel}`);
          return model;
        },
        texture: () => {
          throw new Error('Unexpected external texture');
        },
        audio: () => {
          throw new Error('Unexpected external sound');
        },
      },
    },
  );
  const adapter = createRenderAdapter('fps', { presentation: { manifest, assets } });
  adapter.mount(world);
  const runtime = adapter.presentation!;
  const actor = runtime.entity('responder')!;
  const show = (generation = 0) => {
    adapter.sync(world);
    runtime.present({
      tick: world.tick,
      generation,
      tickRate: 60,
      paused: true,
      events: world.events.thisTick(),
    });
    return wardenJoints.map((joint) => actor.object.getObjectByName(joint)!.quaternion.toArray());
  };
  return {
    world,
    simulation,
    actor,
    show,
    clips: model.animations,
    responder: entities['responder']!,
    dispose() {
      adapter.dispose();
      assets.dispose();
    },
  };
}

describe('Cable Warden in the running station (headless)', () => {
  it('turns in pursuit, strides 0.025 units per tick on the empty path through 5348, and blends from the 5349 stop', async () => {
    const run = await mission(horror.script, 5358);
    try {
      const { world, simulation, responder, actor } = run;
      const spawn = world.snapshot();
      run.show();
      simulation.run(5118);
      run.show();
      const beforeTurn = actor.root.quaternion.clone();
      simulation.step();
      run.show();
      expect(beforeTurn.angleTo(actor.root.quaternion)).toBeGreaterThan(1);
      simulation.run(5318 - world.tick);
      run.show();
      const previous = actor.root.position.clone();
      for (let tick = 5319; tick <= 5358; tick++) {
        simulation.step();
        const rotations = run.show();
        const ai = world.getOrThrow(responder, HorrorThreat);
        const { position, rotation } = world.getOrThrow(responder, Transform);
        expect(ai.mode).toBe('search');
        expect(actor.root.position.toArray()).toEqual([position.x, position.y, position.z]);
        expect(actor.root.quaternion.toArray()).toEqual([
          rotation.x,
          rotation.y,
          rotation.z,
          rotation.w,
        ]);
        expect(ai.path).toHaveLength(0);
        const distance = actor.root.position.distanceTo(previous);
        if (tick <= 5348) expect(distance).toBeCloseTo(0.025, 10);
        else expect(distance).toBe(0);
        previous.copy(actor.root.position);
        expectApproachPose(run.clips, tick, rotations);
        expect(run.show()).toEqual(rotations);
        if (tick === 5348 || tick === 5349) expect(world.hash()).toBe(approachHashes[tick]);
      }
      world.restore(spawn);
      const restarted = run.show(1);
      for (const [i, joint] of wardenJoints.entries())
        expect(
          new Quaternion()
            .fromArray(restarted[i]!)
            .normalize()
            .angleTo(clipRotation(run.clips, 'Idle', joint, 0)),
        ).toBeLessThan(1e-5);
    } finally {
      run.dispose();
    }
  });

  it('lets the real 48-tick catch warning override the stationary loop with Lunge', async () => {
    const run = await mission('games/horror/play/caught.input', 3229);
    try {
      run.simulation.run(3180);
      run.show();
      const at = new Vector3();
      while (run.world.tick < 3229) {
        run.simulation.step();
        const rotations = run.show();
        const tick = run.world.tick;
        if (tick === 3182) at.copy(run.actor.root.position);
        if (tick >= 3182 && tick <= 3228) {
          expect(run.actor.root.position.distanceTo(at)).toBe(0);
          const expected = clipRotation(run.clips, 'Lunge', 'helmet', (tick - 3181) / 60);
          expect(
            new Quaternion().fromArray(rotations[2]!).normalize().angleTo(expected),
          ).toBeLessThan(1e-5);
        }
      }
      const events = run.world.events.history();
      expect(events.filter((e) => e.type === 'horror.threat.warning').map((e) => e.tick)).toEqual([
        3181,
      ]);
      expect(events.filter((e) => e.type === 'player.died').map((e) => e.tick)).toEqual([3228]);
    } finally {
      run.dispose();
    }
  });
});
