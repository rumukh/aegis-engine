import { expect, it } from 'vitest';
import { EMPTY_INPUT_FRAME } from '@aegis/core';
import { parseInputScript } from '@aegis/harness';
import { pocGames } from '../poc/poc-games.mjs';
import { createLiveSession } from '../packages/render-three/src/session.js';

it('plays the benchmark input through the live fixed-step clock to the shipped win and hash', async () => {
  const game = (await pocGames()).find((item) => item.id === 'horror')!;
  const parsed = parseInputScript(game.script);
  if (!parsed.ok || !parsed.value) throw new Error('Invalid shipped route');
  const frames = parsed.value.frames(8217);
  const run = createLiveSession({
    scene: game.scene,
    plugin: game.plugin,
    replayInput: { frameFor: (tick) => frames[tick] ?? { ...EMPTY_INPUT_FRAME, tick } },
  });
  // Different display cadence from the 60 Hz simulation. No World/Transform writes or seeking.
  while (run.tick < 8217) expect(run.advance(3 / 60)).toBe(3);
  expect(
    run.world.events
      .history()
      .filter((e) => e.type === 'level.completed')
      .map((e) => e.tick),
  ).toEqual([8153]);
  expect(run.world.events.contains('player.died')).toBe(false);
  expect(run.hash()).toBe('7a8eeb4d3cdd4dae');
  run.restart();
  expect(run.tick).toBe(0);
  expect(run.world.events.history()).toEqual([]);
});
