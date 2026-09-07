import { coyoteGapPlugin } from '@aegis/game-platformer';

/** Game-owned composition. Asset URLs and visual mappings never enter the simulation scene. */
export const platformer = {
  id: 'platformer',
  title: 'Coyote Gap',
  blurb: 'A cliffside expedition across broken ledges, a lava ferry and the final leap.',
  objective: 'Clear the patrol, ride the ferry and reach the far beacon.',
  plugin: coyoteGapPlugin,
  pluginModule: '@aegis/game-platformer',
  pluginExport: 'coyoteGapPlugin',
  packageDir: 'games/platformer',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  script: 'games/platformer/play/coyote-gap.input',
  scriptTicks: 400,
  acceptance: { winEvent: 'level.completed', playerName: 'player' },
  presentation: {
    manifest: {
      aegis: 'presentation/1',
      ui: { accent: '#efb86a', eyebrow: 'Cliffside expedition' },
      hud: {
        playerName: 'player',
        winEvent: 'level.completed',
        loseEvents: ['player.died'],
        steps: [
          { id: 'patrol', label: 'Clear the patrol', event: 'enemy.killed' },
          { id: 'ferry', label: 'Board the ferry', event: 'platform.boarded' },
          { id: 'beacon', label: 'Reach the beacon', event: 'level.completed' },
        ],
      },
    },
  },
};
