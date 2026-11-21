import { Health } from '@aegis/content';
import { fpsPlugin, FPS_EVENTS, FPS_INPUTS } from '@aegis/mode-fps';

/** @type {import('@aegis/harness').ModePlugin} */
export const cinematicPlugin = {
  ...fpsPlugin,
  events: () => ({ ...FPS_EVENTS, sample: { fields: {} } }),
};

/** @type {import('@aegis/harness').ModePlugin} */
export const lossPlugin = {
  ...fpsPlugin,
  inputs: () => ({ ...FPS_INPUTS, actions: [...FPS_INPUTS.actions, 'Lose', 'Win'] }),
  events: () => ({
    ...FPS_EVENTS,
    'fixture.lost': { fields: { actor: 'number' } },
    'fixture.won': { fields: {} },
  }),
  systems: () =>
    fpsPlugin.systems().add({
      name: 'fixture.outcome',
      phase: 'postUpdate',
      run({ world, input }) {
        const player = world.query({ has: ['FpsController', Health] }).one();
        if (input.pressed.includes('Lose') && player.get(Health).current > 0) {
          player.get(Health).current = 0;
          world.events.emit('fixture.lost', { actor: player.entity });
        }
        if (input.pressed.includes('Win')) world.events.emit('fixture.won', {});
      },
    }),
};
