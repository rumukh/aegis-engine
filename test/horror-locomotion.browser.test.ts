import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseInputScript } from '@aegis/harness';
import { horror } from '../poc/horror.mjs';
import { pocGames } from '../poc/poc-games.mjs';
import { startDevServer } from '../packages/render-three/src/dev-server.js';
import {
  evaluate,
  launchBrowser,
  openPage,
  screenshot,
  stopExternalLagWitness,
  until,
} from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { navigateAndWait } from '../packages/render-three/src/browser-navigation.js';
import {
  approachHashes,
  expectApproachPose,
  loadWarden,
  wardenJoints,
} from './support/warden-approach.js';

it('Cable Warden: the live station approach turns in Stalk and blends to Search only at rest', async () => {
  const [game] = await pocGames(undefined, [horror]);
  assert.ok(game);
  const script = parseInputScript(game.script).value;
  assert.ok(script);
  const frames = script.frames(5358);
  const { animations } = await loadWarden();
  const server = await startDevServer({
    port: 0,
    games: [game],
    replayInputs: new Map([['horror', { frameFor: (tick) => frames[tick]! }]]),
  });
  const control = async (command: 'pause' | 'step' | 'restart', ticks = 1) => {
    const response = await fetch(`${server.url}/api/horror/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, ticks }),
    });
    expect(response.ok).toBe(true);
    await response.arrayBuffer();
  };
  try {
    await control('pause');
    await control('restart');
    const viewport = { width: 960, height: 540 };
    const browser = await launchBrowser({ viewport });
    try {
      const page = await openPage(browser.port, `${server.url}/play/horror/`, viewport);
      try {
        await until(page, 'globalThis.aegis?.presentation().status', (v) => v === 'ready');
        const sample = () =>
          evaluate<{
            tick: number;
            hash: string;
            pathLength: number;
            mode: string;
            position: number[];
            facingZ: number;
            rotations: number[][];
          }>(
            page,
            `(async () => {
          const a = globalThis.aegis;
          await a.sync();
          const actor = a.adapter.presentation.entity('responder');
          const ai = a.world.query({has:['HorrorThreat']}).one().get('HorrorThreat');
          return {tick:a.tick(), hash:a.world.hash(), pathLength:ai.path.length, mode:ai.mode, facingZ:ai.facingZ,
            position:actor.root.position.toArray(), rotations:${JSON.stringify(wardenJoints)}.map(j => actor.object.getObjectByName(j).quaternion.toArray())};
        })()`,
          );
        const spawn = await sample();
        expect(spawn.tick).toBe(0);
        // The player has broken sight by this beat. Observe the real actor from the corridor;
        // the test camera is display-only, and neither the player's view state nor input is edited.
        await evaluate(
          page,
          `(() => {
          const {camera,presentation} = globalThis.aegis.adapter;
          presentation.addEffect({update({tick}) {
            if(tick < 5318) { camera.position.set(21,1.25,24.5); camera.lookAt(23,1.1,22.2); }
            else { camera.position.set(13.4,1.25,19.4); camera.lookAt(14.1,1.1,22); }
            camera.updateMatrixWorld();
          }, reset(){}, dispose(){}});
          return null;
        })()`,
        );
        const artifacts = process.env['AEGIS_HORROR_ARTIFACTS'];
        const capture = async (tick: number) => {
          if (artifacts !== undefined)
            await screenshot(page, join(artifacts, `warden-corridor-${tick}.png`));
        };
        await control('step', 5118);
        const approaching = await sample();
        await capture(5118);
        await control('step');
        const turn = await sample();
        expect(turn.tick).toBe(5119);
        expect(turn.mode).toBe('chase');
        expect(Math.abs(turn.facingZ - approaching.facingZ)).toBeGreaterThan(0.8);
        await capture(5119);
        await control('step', 5318 - turn.tick);
        let previous = await sample();
        for (const tick of [5319, 5334, 5347, 5348, 5349, 5350, 5353, 5357]) {
          await control('step', tick - previous.tick);
          const frame = await sample();
          expect(frame.tick).toBe(tick);
          expect(frame.mode).toBe('search');
          expect(frame.pathLength).toBe(0);
          if (tick <= 5348) {
            const travel = Math.hypot(...frame.position.map((v, i) => v - previous.position[i]!));
            expect(travel).toBeCloseTo(0.025 * (tick - previous.tick), 10);
          } else expect(frame.position).toEqual(previous.position);
          expectApproachPose(animations, tick, frame.rotations);
          if (tick === 5348 || tick === 5349) expect(frame.hash).toBe(approachHashes[tick]);
          if (tick === 5353) expect(await sample()).toEqual(frame);
          await capture(tick);
          previous = frame;
        }
        await control('restart');
        expect(await sample()).toEqual(spawn);
      } finally {
        try {
          await navigateAndWait(page, () => page.send('Page.navigate', { url: 'about:blank' }));
        } finally {
          page.close();
        }
      }
    } finally {
      await closeOwnedBrowser(browser, { inspectProcesses: true });
      await rm(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  } finally {
    stopExternalLagWitness();
    await server.close();
  }
}, 180_000);
