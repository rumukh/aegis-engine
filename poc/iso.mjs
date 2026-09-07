import { serverVaultPlugin } from '@aegis/game-iso';

export const iso = {
  id: 'iso',
  title: 'The Server Vault',
  blurb: 'A tactical security breach through guarded corridors and a sealed data vault.',
  objective: 'Neutralize the guard, activate the security switch and extract.',
  plugin: serverVaultPlugin,
  pluginModule: '@aegis/game-iso',
  pluginExport: 'serverVaultPlugin',
  packageDir: 'games/iso',
  scene: 'games/iso/levels/server-vault.scene.json',
  script: 'games/iso/play/server-vault.input',
  scriptTicks: 960,
  acceptance: { winEvent: 'mission.completed', playerName: 'operative' },
  presentation: {
    manifest: {
      aegis: 'presentation/1',
      ui: { accent: '#73d9ce', eyebrow: 'Security diorama' },
      hud: {
        playerName: 'operative',
        winEvent: 'mission.completed',
        loseEvents: ['player.died'],
        steps: [
          { id: 'guard', label: 'Neutralize security', event: 'enemy.killed' },
          { id: 'switch', label: 'Activate the switch', event: 'switch.activated' },
          { id: 'extract', label: 'Reach extraction', event: 'mission.completed' },
        ],
      },
    },
  },
};
