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
import { Transform } from '@aegis/core';
import type { StateHash } from '@aegis/core';
import { runScene } from '@aegis/harness';
import {
  PlatformerCollision,
  PlatformerController,
  platformerPlugin,
} from '@aegis/mode-platformer';
import { createLiveSession } from './session.js';
import type { LiveSession } from './session.js';
import { PLATFORMER_SCENE } from './testing/scenes.js';

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
});
