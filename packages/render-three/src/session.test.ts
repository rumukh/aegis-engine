/**
 * The live session: the same world a headless `runScene` builds, stepped in real time.
 *
 * The load-bearing test here is that a *played* session and a *scripted* run of the same input
 * land on the same state hash — including when the played session is advanced with jittered
 * wall-clock frames. That is what makes "a human drove it" and "a script drove it" the same thing
 * as far as the simulation is concerned.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { DiagnosticError, Transform } from '@aegis/core';
import type { StateHash } from '@aegis/core';
import { ContentCode, createPrefabResolver, createResourceRegistry } from '@aegis/content';
import type { SceneFile } from '@aegis/content';
import { createSceneContext, runScene } from '@aegis/harness';
import { isoPlugin } from '@aegis/mode-iso';
import { fpsPlugin } from '@aegis/mode-fps';
import {
  PlatformerCollision,
  PlatformerController,
  platformerPlugin,
} from '@aegis/mode-platformer';
import { createLiveSession } from './session.js';
import type { LiveSession } from './session.js';
import { FPS_SCENE, ISO_SCENE, PLATFORMER_SCENE } from './testing/scenes.js';

const TICKS = 60;

/** The headless reference: hold right for the whole run. */
async function scriptedHash(): Promise<StateHash> {
  const result = await runScene(PLATFORMER_SCENE, {
    plugin: platformerPlugin,
    ticks: TICKS,
    input: `axis MoveX 1 0..${TICKS}`,
  });
  return result.hash;
}

/** The player's world x. */
function playerX(session: LiveSession): number {
  return session.world
    .query({ has: [PlatformerController, Transform] })
    .one()
    .get(Transform).position.x;
}

describe('live session', () => {
  it('starts at tick 0 with the scene instantiated and the plugin init run', () => {
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    expect(session.tick).toBe(0);
    expect(session.dt).toBeCloseTo(1 / 60);
    expect(session.world.query({ has: [PlatformerController] }).count()).toBe(1);
    // `platformerInit` bakes the tilemap; without it the physics has nothing to stand on.
    expect(session.world.getResource(PlatformerCollision)?.width).toBe(12);
  });

  it.each([0, -1, NaN, Infinity, Number.MIN_VALUE])(
    'rejects invalid live-session tick rate %s',
    (tickRate) => {
      expect(() =>
        createLiveSession({
          scene: PLATFORMER_SCENE,
          plugin: platformerPlugin,
          tickRate,
        }),
      ).toThrow(/tickRate/);
    },
  );

  it('uses the same nondefault rate as a headless run', async () => {
    const session = createLiveSession({
      scene: PLATFORMER_SCENE,
      plugin: platformerPlugin,
      tickRate: 30,
    });
    session.input.submit({ seq: 1, axes: { MoveX: 1 } });
    for (let i = 0; i < 3; i++) session.step();
    const run = await runScene(PLATFORMER_SCENE, {
      plugin: platformerPlugin,
      ticks: 3,
      tickRate: 30,
      input: 'axis MoveX 1 0..3',
    });
    expect(session.dt).toBe(1 / 30);
    expect(session.hash()).toBe(run.hash);
  });

  it('reaches the same state hash as the headless harness for the same input', async () => {
    const reference = await scriptedHash();
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    session.input.submit({ seq: 1, axes: { MoveX: 1 } });
    for (let tick = 0; tick < TICKS; tick++) session.step();

    expect(session.tick).toBe(TICKS);
    expect(playerX(session)).toBeGreaterThan(1.5);
    expect(session.hash()).toBe(reference);
  });

  it('advances from jittered wall-clock without changing the resulting state', async () => {
    const reference = await scriptedHash();
    const session = createLiveSession({
      scene: PLATFORMER_SCENE,
      plugin: platformerPlugin,
      maxStepsPerFrame: 64,
    });
    session.input.submit({ seq: 1, axes: { MoveX: 1 } });

    // Deliberately ugly frame pacing, summing to just under one second of simulated time.
    const frames = [0.004, 0.12, 0.016, 0.016, 0.05, 0.008, 0.033, 0.09, 0.25, 0.39];
    for (const frame of frames) session.advance(frame);
    expect(session.tick).toBeGreaterThan(0);
    expect(session.tick).toBeLessThanOrEqual(TICKS);
    while (session.tick < TICKS) session.step();

    expect(session.tick).toBe(TICKS);
    expect(session.hash()).toBe(reference);
  });

  it('does not advance while paused, but a single step still works', () => {
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    session.paused = true;
    expect(session.advance(1)).toBe(0);
    expect(session.tick).toBe(0);
    session.step();
    expect(session.tick).toBe(1);
    session.paused = false;
    expect(session.advance(1 / 60)).toBe(1);
    expect(session.tick).toBe(2);
  });

  it('restart preserves the paused flag rather than resuming behind your back', () => {
    // A human who paused, hit R and got a world already sprinting away lost the thing they
    // paused for — and automation that restarts to reach a known tick 0 cannot do so at all if
    // the simulation resumes underneath it.
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    session.paused = true;
    session.step();
    session.restart();
    expect(session.paused).toBe(true);
    expect(session.tick).toBe(0);
    expect(session.advance(1)).toBe(0);
    expect(session.tick).toBe(0);

    session.paused = false;
    session.restart();
    expect(session.paused).toBe(false);
  });

  it('clears pending gameplay only on pause transitions, preserving deliberate paused steps', () => {
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    session.input.submit({ seq: 1, held: ['Fire'], pressed: ['Fire'], axes: { MoveX: 1 } });
    session.paused = true;
    expect(session.input.frameFor(0)).toMatchObject({ actions: {}, pressed: [], axes: {} });
    session.input.submit({ seq: 2, held: ['Jump'], pressed: ['Jump'] });
    session.paused = true;
    expect(session.input.frameFor(0).pressed).toEqual(['Jump']);
    session.input.submit({ seq: 3, held: ['Fire'], pressed: ['Fire'] });
    session.paused = false;
    expect(session.input.frameFor(0)).toMatchObject({ actions: {}, pressed: [] });
  });

  it('restart rebuilds the world at tick 0 with the same starting hash', () => {
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    const initial = session.hash();
    const start = playerX(session);

    session.input.submit({ seq: 1, axes: { MoveX: 1 } });
    for (let i = 0; i < 30; i++) session.step();
    expect(session.hash()).not.toBe(initial);

    session.restart();
    expect(session.tick).toBe(0);
    expect(session.hash()).toBe(initial);
    expect(playerX(session)).toBeCloseTo(start);
  });

  it('does not alias the scene document it was given', () => {
    const scene = structuredClone(PLATFORMER_SCENE);
    const before = JSON.stringify(scene);
    const session = createLiveSession({ scene, plugin: platformerPlugin });
    for (let i = 0; i < 20; i++) session.step();
    expect(JSON.stringify(scene)).toBe(before);
  });

  it('produces a snapshot that is plain, round-trippable JSON', () => {
    const session = createLiveSession({ scene: PLATFORMER_SCENE, plugin: platformerPlugin });
    for (let i = 0; i < 10; i++) session.step();
    const snapshot = session.snapshot();
    expect(snapshot.tick).toBe(session.tick);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it.each([
    {
      plugin: platformerPlugin,
      scene: PLATFORMER_SCENE,
      id: 'platformer.tilemap',
      ids: ['platformer.collision', 'platformer.tilemap'],
    },
    { plugin: isoPlugin, scene: ISO_SCENE, id: 'IsoGrid', ids: ['IsoGrid', 'NavGrid'] },
    {
      plugin: fpsPlugin,
      scene: FPS_SCENE,
      id: 'fps.floorplan',
      ids: ['fps.collision', 'fps.floorplan'],
    },
  ])(
    'validates $id identically in headless and live initialization',
    async ({ plugin, scene, id, ids }) => {
      expect(createSceneContext(plugin).resources.ids()).toEqual(ids);
      const run = await runScene(scene, { plugin, ticks: 0 });
      const live = createLiveSession({ scene, plugin });
      expect(live.hash()).toBe(run.hash);
      const typo: SceneFile = {
        ...scene,
        resources: { [`${id}x`]: scene.resources?.[id] },
      };
      expect(() => createLiveSession({ scene: typo, plugin })).toThrow(DiagnosticError);
      await expect(runScene(typo, { plugin, ticks: 1 })).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ code: ContentCode.UnknownResource })],
      });
    },
  );

  it('preserves explicit prefab and game-resource declarations across restart', async () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'live-prefab',
      mode: 'platformer',
      resources: { 'game.config': { difficulty: 2 } },
      entities: [{ id: 'instance', prefab: 'actor' }],
    };
    const prefabs = createPrefabResolver({
      aegis: 'prefab/1',
      name: 'actor',
      components: { Transform: { position: { x: 7, y: 0, z: 0 } } },
      children: [{ id: 'child', components: { Transform: { position: { x: 1, y: 0, z: 0 } } } }],
    });
    const resources = createResourceRegistry('game.config');
    const options = { scene, plugin: platformerPlugin, resources, prefabs };
    const session = createLiveSession(options);
    const initial = session.hash();
    expect(
      session.world
        .query({ has: [Transform] })
        .views()
        .map((v) => v.get(Transform).position.x),
    ).toEqual([7, 8]);
    expect(session.snapshot().entities.map((e) => e.name)).toEqual(['instance', 'instance/child']);
    session.step();
    session.restart();
    expect(session.hash()).toBe(initial);
    expect(session.snapshot().resources['game.config']).toEqual({ difficulty: 2 });
    const run = await runScene(scene, { ...options, ticks: 0 });
    expect(run.hash).toBe(initial);
  });
});
