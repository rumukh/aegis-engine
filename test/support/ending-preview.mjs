import { fpsPlugin, FPS_EVENTS, FPS_INPUTS } from '@aegis/mode-fps';

/** The same fixture module runs in Node and in the exported browser game. */
/** @type {import('@aegis/harness').ModePlugin} */
export const plugin = {
  ...fpsPlugin,
  inputs: () => ({ ...FPS_INPUTS, actions: [...FPS_INPUTS.actions, 'Win'] }),
  events: () => ({ ...FPS_EVENTS, 'level.completed': { fields: {} } }),
  systems: () =>
    fpsPlugin.systems().add({
      name: 'fixture.win',
      phase: 'postUpdate',
      run({ world, input }) {
        if (input.pressed.includes('Win')) world.events.emit('level.completed', {});
      },
    }),
};
