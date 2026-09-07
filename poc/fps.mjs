import { sectorBreachPlugin } from '@aegis/game-fps';

export const fps = {
  id: 'fps',
  title: 'Sector Breach',
  blurb: 'An orbital-facility incursion: breach the blast door, cross the coolant and escape.',
  objective: 'Shoot the panel, clear the coolant pit, defeat security and reach the exit.',
  plugin: sectorBreachPlugin,
  pluginModule: '@aegis/game-fps',
  pluginExport: 'sectorBreachPlugin',
  packageDir: 'games/fps',
  scene: 'games/fps/levels/sector-breach.scene.json',
  script: 'games/fps/play/sector-breach.input',
  scriptTicks: 600,
  acceptance: {
    winEvent: 'level.completed',
    playerName: 'player',
    photoEvent: 'enemy.damaged',
  },
  presentation: {
    manifest: {
      aegis: 'presentation/1',
      ui: { accent: '#90b9f6', eyebrow: 'Orbital facility' },
      hud: {
        playerName: 'player',
        winEvent: 'level.completed',
        loseEvents: ['player.died'],
        steps: [
          { id: 'door', label: 'Open the blast door', event: 'door.opened' },
          { id: 'security', label: 'Defeat security', event: 'enemy.killed' },
          { id: 'exit', label: 'Reach the exit', event: 'level.completed' },
        ],
      },
    },
  },
};
