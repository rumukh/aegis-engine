import { fileURLToPath } from 'node:url';
import { serverVaultPlugin, WALL_ROWS } from '@aegis/game-iso';

const provenance = {
  author: 'Aegis contributors',
  license: 'MIT',
  source: 'source/generate.mjs; LICENSE.txt; provenance.json',
};
const cells = WALL_ROWS.flatMap((row, z) =>
  [...row].map((tile, x) => ({ tile, position: [x, 0, z] })),
);
const rearRacks = [
  ...[1, 2, 3, 5, 6, 7, 9, 10].map((x) => ({ position: [x, 0.425, 0] })),
  ...[2, 3, 5, 6].map((z) => ({ position: [0, 0.425, z], rotation: [0, 90, 0] })),
];
const characterMotion = { idle: 'idle', move: 'walk', dead: 'death' };

/** @type {import('@aegis/render-three/presentation/schema').PresentationSource} */
export const vaultPresentation = {
  assetRoot: fileURLToPath(new URL('../games/iso/assets/', import.meta.url)),
  manifest: {
    aegis: 'presentation/1',
    camera: { framing: 'level', padding: 1.1 },
    assets: [
      ...[
        'operative',
        'sentinel',
        'service-partition',
        'server-rack',
        'access-console',
        'vault-door',
        'extraction-pad',
        'vault-plinth',
      ].map((id) => ({ id, kind: 'gltf', src: `${id}.gltf`, provenance })),
      { id: 'deck-panel', kind: 'texture', src: 'deck-panel.png', provenance },
      { id: 'vault-mark', kind: 'texture', src: 'vault-mark.png', provenance },
      {
        id: 'vault-icons',
        kind: 'texture',
        src: 'vault-icons.svg',
        provenance,
        frames: {
          operative: [0, 0, 0.25, 1],
          lock: [0.25, 0, 0.5, 1],
          console: [0.5, 0, 0.75, 1],
          extraction: [0.75, 0, 1, 1],
        },
      },
      ...[
        'vault-air',
        'pulse-shot',
        'armor-hit',
        'guard-alert',
        'access-granted',
        'vault-unseal',
        'route-denied',
        'extraction',
      ].map((id) => ({ id, kind: 'audio', src: `${id}.wav`, provenance })),
    ],
    materials: [
      {
        id: 'deck',
        shading: 'standard',
        map: 'deck-panel',
        roughness: 0.8,
        metalness: 0.22,
      },
      {
        id: 'service-metal',
        shading: 'standard',
        color: '#4a6879',
        roughness: 0.6,
        metalness: 0.4,
      },
      { id: 'cool-trim', shading: 'unlit', color: '#55bfc5' },
      { id: 'warm-trim', shading: 'unlit', color: '#dbaa62' },
      { id: 'operative-signal', shading: 'unlit', color: '#78e7dc' },
      { id: 'sentinel-signal', shading: 'unlit', color: '#e6a36a' },
      { id: 'spent-signal', shading: 'unlit', color: '#344552' },
    ],
    surfaces: {
      floor: 'deck',
      player: 'operative-signal',
      enemy: 'sentinel-signal',
      dead: 'spent-signal',
    },
    entities: [
      {
        target: { name: 'operative' },
        visual: { kind: 'model', mesh: 'operative', animations: characterMotion },
        fit: 'authored',
      },
      {
        target: { name: 'guard' },
        visual: { kind: 'model', mesh: 'sentinel', animations: characterMotion },
        fit: 'authored',
      },
      {
        target: { name: 'security-switch' },
        visual: { kind: 'model', mesh: 'access-console' },
        fit: 'authored',
      },
      {
        target: { name: 'vault-door' },
        visual: { kind: 'model', mesh: 'vault-door' },
        fit: 'authored',
      },
      {
        target: { name: 'vault-exit' },
        visual: { kind: 'model', mesh: 'extraction-pad' },
        fit: 'authored',
      },
    ],
    // Both batches derive from the collision source, never from a decorative floorplan.
    legacy: { level: false },
    objects: [
      {
        id: 'walkable-deck',
        visual: { kind: 'primitive', shape: 'box', material: 'deck' },
        instances: cells
          .filter(({ tile }) => tile !== '#')
          .map(({ position: [x, , z] }) => ({
            position: [x, -0.04, z],
            scale: [0.94, 0.08, 0.94],
          })),
      },
      {
        id: 'service-partitions',
        visual: { kind: 'model', mesh: 'service-partition' },
        instances: cells.filter(({ tile }) => tile === '#').map(({ position }) => ({ position })),
      },
      {
        id: 'structural-plinth',
        visual: { kind: 'model', mesh: 'vault-plinth' },
        pose: { position: [5.5, 0, 4] },
      },
      {
        id: 'rear-server-banks',
        visual: { kind: 'model', mesh: 'server-rack' },
        instances: rearRacks,
      },
      {
        id: 'rear-service-header',
        visual: { kind: 'primitive', shape: 'box', material: 'service-metal' },
        instances: [
          { position: [5.5, 2.27, -0.24], scale: [11.4, 0.11, 0.16] },
          { position: [-0.24, 2.27, 4], scale: [0.16, 0.11, 7.8] },
        ],
      },
      {
        id: 'rear-power-conduits',
        visual: { kind: 'primitive', shape: 'box', material: 'cool-trim' },
        instances: [
          { position: [5.5, 2.31, -0.145], scale: [11.2, 0.024, 0.016] },
          { position: [-0.145, 2.31, 4], scale: [0.016, 0.024, 7.6] },
          ...[4, 8].map((x) => ({ position: [x, 1.36, -0.33], scale: [0.05, 1.76, 0.05] })),
        ],
      },
      {
        id: 'cutaway-edge-light',
        visual: { kind: 'primitive', shape: 'box', material: 'cool-trim' },
        instances: [
          { position: [5.5, 0.437, 8.32], scale: [11.4, 0.014, 0.022] },
          { position: [11.32, 0.437, 4], scale: [0.022, 0.014, 7.5] },
        ],
      },
      {
        id: 'patrol-aisle-edge',
        visual: { kind: 'primitive', shape: 'box', material: 'cool-trim' },
        instances: [
          { position: [5.5, 0.006, 5.42], scale: [9.82, 0.01, 0.018] },
          { position: [1.42, 0.006, 3], scale: [0.018, 0.01, 3.8] },
        ],
      },
      {
        id: 'vault-approach-stripes',
        visual: { kind: 'primitive', shape: 'box', material: 'warm-trim' },
        instances: [3.7, 3.85, 4, 4.15, 4.3].map((x) => ({
          position: [x, 0.012, 5.39],
          rotation: [0, 35, 0],
          scale: [0.06, 0.01, 0.15],
        })),
      },
      {
        id: 'vault-identity',
        visual: { kind: 'sprite', texture: 'vault-mark' },
        pose: { position: [5.5, 2.85, -0.28], scale: [3.2, 0.8, 1] },
      },
      {
        id: 'access-affordance',
        anchor: { entity: 'security-switch' },
        visual: { kind: 'sprite', texture: 'vault-icons', frame: 'console' },
        pose: { position: [0, 0.87, -0.05], rotation: [0, 45, 0], scale: [0.26, 0.26, 1] },
      },
      {
        id: 'extraction-affordance',
        anchor: { entity: 'vault-exit' },
        visual: { kind: 'sprite', texture: 'vault-icons', frame: 'extraction' },
        pose: { position: [0, 0.72, -0.12], rotation: [0, 45, 0], scale: [0.27, 0.27, 1] },
      },
    ],
    effects: [
      {
        event: 'enemy.damaged',
        kind: 'clip',
        target: { entity: 'operative' },
        clip: 'attack',
        durationTicks: 17,
      },
      {
        event: 'damage.taken',
        kind: 'clip',
        target: { entity: 'guard' },
        clip: 'attack',
        durationTicks: 17,
      },
      {
        event: 'enemy.damaged',
        kind: 'burst',
        target: { entity: 'operative', node: 'weapon' },
        count: 4,
        amount: 0.09,
        color: '#a5fff0',
        durationTicks: 9,
      },
      {
        event: 'damage.taken',
        kind: 'burst',
        target: { entity: 'guard', node: 'weapon' },
        count: 4,
        amount: 0.09,
        color: '#ffd692',
        durationTicks: 9,
      },
      {
        event: 'enemy.damaged',
        kind: 'pulse',
        target: { entity: 'guard', node: 'torso' },
        amount: 0,
        color: '#fff1c9',
        durationTicks: 12,
      },
      {
        event: 'damage.taken',
        kind: 'pulse',
        target: { entity: 'operative', node: 'torso' },
        amount: 0,
        color: '#ed765a',
        durationTicks: 16,
      },
      {
        event: 'guard.alerted',
        kind: 'pulse',
        target: { entity: 'guard', node: 'head' },
        amount: 0.07,
        color: '#ffcc83',
        durationTicks: 26,
      },
      {
        event: 'enemy.killed',
        kind: 'clip',
        target: { entity: 'guard' },
        clip: 'death',
        durationTicks: 36,
        holdLast: true,
      },
      {
        event: 'player.died',
        kind: 'clip',
        target: { entity: 'operative' },
        clip: 'death',
        durationTicks: 36,
        holdLast: true,
      },
      {
        event: 'switch.activated',
        kind: 'clip',
        target: { entity: 'security-switch' },
        clip: 'activate',
        durationTicks: 24,
        holdLast: true,
      },
      {
        event: 'switch.activated',
        kind: 'pulse',
        target: { object: 'access-affordance' },
        amount: 0.18,
        color: '#b5fff0',
        durationTicks: 28,
      },
      {
        event: 'door.opened',
        kind: 'clip',
        target: { entity: 'vault-door' },
        clip: 'unseal',
        durationTicks: 50,
        holdLast: true,
      },
      {
        event: 'path.blocked',
        kind: 'pulse',
        target: { entity: 'operative', node: 'head' },
        amount: 0,
        color: '#ffb763',
        durationTicks: 18,
      },
      {
        event: 'mission.completed',
        kind: 'clip',
        target: { entity: 'vault-exit' },
        clip: 'extract',
        durationTicks: 66,
        holdLast: true,
      },
      {
        event: 'mission.completed',
        kind: 'pulse',
        target: { object: 'extraction-affordance' },
        amount: 0.3,
        color: '#c9fff1',
        durationTicks: 50,
      },
    ],
    environment: {
      background: '#0a1421',
      ambient: { color: '#b4d0e2', intensity: 1.4 },
      directional: { color: '#edf3f4', intensity: 2.2, position: [4, 12, 7] },
      points: [
        { color: '#49a6ca', intensity: 7, position: [3, 2.8, 1], distance: 6 },
        { color: '#62ccc8', intensity: 5, position: [7, 2.6, 2], distance: 5 },
        { color: '#e9ae62', intensity: 3, position: [9, 1.6, 1], distance: 3 },
        { color: '#60d8cd', intensity: 4, position: [4, 1.8, 7], distance: 4 },
      ],
    },
    audio: {
      volume: 0.68,
      ambient: { asset: 'vault-air', volume: 0.16 },
      cues: [
        { event: 'attack.fired', asset: 'pulse-shot', volume: 0.48 },
        { event: 'damage.taken', asset: 'armor-hit', volume: 0.55 },
        { event: 'enemy.damaged', asset: 'armor-hit', volume: 0.32 },
        { event: 'guard.alerted', asset: 'guard-alert', volume: 0.45 },
        { event: 'switch.activated', asset: 'access-granted', volume: 0.58 },
        { event: 'door.opened', asset: 'vault-unseal', volume: 0.48 },
        { event: 'path.blocked', asset: 'route-denied', volume: 0.35, cooldownTicks: 18 },
        { event: 'mission.completed', asset: 'extraction', volume: 0.65 },
      ],
    },
    ui: { accent: '#73d9ce', eyebrow: 'VAULT 07 / Tactical infiltration', cover: 'vault-mark' },
    hud: {
      playerName: 'operative',
      winEvent: 'mission.completed',
      loseEvents: ['player.died'],
      steps: [
        { id: 'guard', label: 'Neutralize security', event: 'enemy.killed' },
        { id: 'switch', label: 'Authorize access', event: 'switch.activated' },
        { id: 'door', label: 'Unseal the vault', event: 'door.opened' },
        { id: 'extract', label: 'Extract the data', event: 'mission.completed' },
      ],
    },
    quality: 'standard',
  },
};

export const iso = {
  id: 'iso',
  title: 'The Server Vault',
  blurb: 'Infiltrate a live server vault, outmaneuver its sentinel and extract the secured data.',
  objective:
    'Click a cell to move; click the sentinel to engage. Authorize access at the gold console, then reach the cyan uplink.',
  plugin: serverVaultPlugin,
  pluginModule: '@aegis/game-iso',
  pluginExport: 'serverVaultPlugin',
  packageDir: 'games/iso',
  scene: 'games/iso/levels/server-vault.scene.json',
  script: 'games/iso/play/server-vault.input',
  scriptTicks: 960,
  acceptance: { winEvent: 'mission.completed', playerName: 'operative' },
  presentation: vaultPresentation,
};
