import { fileURLToPath } from 'node:url';
import { sectorBreachPlugin } from '@aegis/game-fps';

const provenance = {
  author: 'Aegis contributors',
  license: 'MIT',
  source: 'games/fps/assets/generate.mjs',
};

/** @type {import('@aegis/render-three/presentation/schema').PresentationSource} */
const presentation = {
  assetRoot: fileURLToPath(new URL('../games/fps/assets/generated/', import.meta.url)),
  manifest: {
    aegis: 'presentation/1',
    assets: [
      { id: 'facility', kind: 'gltf', src: 'orbital-facility.glb', provenance },
      { id: 'sentry', kind: 'gltf', src: 'kestrel-security.glb', provenance },
      { id: 'rifle', kind: 'gltf', src: 'vaultline-rifle.glb', provenance },
      { id: 'pressure-door', kind: 'gltf', src: 'blast-door.glb', provenance },
      { id: 'lock-panel', kind: 'gltf', src: 'breach-panel.glb', provenance },
      { id: 'extraction', kind: 'gltf', src: 'extraction-pad.glb', provenance },
      { id: 'station-air', kind: 'audio', src: 'station-air.wav', provenance },
      { id: 'coil-shot', kind: 'audio', src: 'coil-shot.wav', provenance },
      { id: 'pressure-open', kind: 'audio', src: 'pressure-open.wav', provenance },
      { id: 'armor-impact', kind: 'audio', src: 'armor-impact.wav', provenance },
      { id: 'suit-impact', kind: 'audio', src: 'suit-impact.wav', provenance },
      { id: 'sentry-shutdown', kind: 'audio', src: 'sentry-shutdown.wav', provenance },
      { id: 'airlock-ready', kind: 'audio', src: 'airlock-ready.wav', provenance },
    ],
    // The asset guard probes every floor/wall boundary; diagnostic collision meshes stay retained.
    legacy: { level: false, triggers: false },
    entities: [
      {
        target: { name: 'grunt' },
        fit: 'authored',
        visual: {
          kind: 'model',
          mesh: 'sentry',
          animations: { idle: 'SentinelIdle', dead: 'Offline' },
        },
      },
      {
        target: { name: 'button' },
        fit: 'authored',
        visual: { kind: 'model', mesh: 'lock-panel' },
      },
      {
        target: { name: 'exit' },
        fit: 'authored',
        visual: { kind: 'model', mesh: 'extraction' },
      },
    ],
    objects: [
      { id: 'station', visual: { kind: 'model', mesh: 'facility' } },
      {
        id: 'blast-door',
        visual: { kind: 'model', mesh: 'pressure-door' },
        pose: { position: [0, 0, 8] },
      },
      {
        id: 'weapon',
        anchor: 'camera',
        visual: { kind: 'model', mesh: 'rifle' },
        pose: { position: [0.31, -0.31, -0.9], scale: [0.85, 0.85, 0.85] },
      },
    ],
    environment: {
      background: '#0c1824',
      ambient: { color: '#9ebed3', intensity: 0.48 },
      directional: { color: '#e4e9db', intensity: 1.1, position: [-3, 5, -4] },
      points: [
        { color: '#ffd0a0', intensity: 10, position: [0, 3.35, 2], distance: 8 },
        { color: '#b8d7f0', intensity: 7, position: [0, 3.3, 8], distance: 6 },
        { color: '#41dcf2', intensity: 10, position: [0, 0.2, 12.5], distance: 5 },
        { color: '#ffc079', intensity: 12, position: [-1.8, 3.3, 17], distance: 9 },
      ],
      fog: { color: '#0c1824', near: 8, far: 28 },
    },
    effects: [
      {
        event: 'weapon.fired',
        kind: 'clip',
        target: { object: 'weapon' },
        clip: 'Fire',
        durationTicks: 11,
      },
      {
        event: 'weapon.fired',
        kind: 'recoil',
        target: { object: 'weapon' },
        amount: 0.035,
        durationTicks: 8,
      },
      {
        event: 'weapon.fired',
        kind: 'burst',
        target: { object: 'weapon', node: 'Muzzle' },
        color: '#ffe7a3',
        count: 6,
        amount: 0.16,
        durationTicks: 4,
      },
      {
        event: 'door.opened',
        kind: 'clip',
        target: { object: 'blast-door' },
        clip: 'Open',
        durationTicks: 48,
        holdLast: true,
      },
      {
        event: 'door.opened',
        kind: 'clip',
        target: { entity: 'button' },
        clip: 'Unlock',
        durationTicks: 12,
        holdLast: true,
      },
      {
        event: 'damage.taken',
        kind: 'clip',
        target: { entity: 'grunt' },
        clip: 'ReturnFire',
        durationTicks: 11,
      },
      {
        event: 'damage.taken',
        kind: 'burst',
        target: { entity: 'grunt', node: 'EnemyMuzzle' },
        color: '#ffba6a',
        count: 5,
        amount: 0.12,
        durationTicks: 4,
      },
      // Color-only target feedback, not scaled hit geometry or a guessed historic impact point.
      {
        event: 'enemy.damaged',
        kind: 'pulse',
        target: { entity: 'grunt' },
        color: '#c7f4ff',
        amount: 0,
        durationTicks: 8,
      },
      {
        event: 'enemy.killed',
        kind: 'clip',
        target: { entity: 'grunt' },
        clip: 'Shutdown',
        durationTicks: 33,
        holdLast: true,
      },
      {
        event: 'enemy.killed',
        kind: 'burst',
        target: { entity: 'grunt', node: 'Chassis' },
        color: '#ffca7b',
        count: 8,
        amount: 0.12,
        durationTicks: 12,
      },
      {
        event: 'level.completed',
        kind: 'pulse',
        target: { entity: 'exit' },
        color: '#b3ffe0',
        amount: 0,
        durationTicks: 36,
      },
    ],
    audio: {
      volume: 0.65,
      ambient: { asset: 'station-air', volume: 0.25 },
      cues: [
        { event: 'weapon.fired', asset: 'coil-shot', volume: 0.7, cooldownTicks: 6 },
        { event: 'door.opened', asset: 'pressure-open', volume: 0.65 },
        { event: 'enemy.damaged', asset: 'armor-impact', volume: 0.55 },
        { event: 'damage.taken', asset: 'suit-impact', volume: 0.7 },
        { event: 'enemy.killed', asset: 'sentry-shutdown', volume: 0.6 },
        { event: 'level.completed', asset: 'airlock-ready', volume: 0.55 },
        { event: 'player.died', asset: 'suit-impact', volume: 0.65 },
      ],
    },
    ui: { accent: '#65dce2', eyebrow: 'Sector 09 / Orbital transfer' },
    hud: {
      playerName: 'player',
      winEvent: 'level.completed',
      loseEvents: ['player.died'],
      steps: [
        { id: 'door', label: 'Shoot the amber breach panel', event: 'door.opened' },
        { id: 'security', label: 'Jump coolant; disable K-09', event: 'enemy.killed' },
        { id: 'exit', label: 'Reach the green extraction pad', event: 'level.completed' },
      ],
    },
    quality: 'standard',
  },
};

export const fps = {
  id: 'fps',
  title: 'Sector Breach',
  blurb: 'An orbital-facility incursion: breach the blast door, cross the coolant and escape.',
  objective:
    'Shoot the amber panel to your right. Jump the coolant breach, disable K-09 and extract.',
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
  presentation,
};
