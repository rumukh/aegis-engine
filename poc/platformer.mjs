import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DiagnosticError } from '@aegis/core';
import { parseScene, parseTilemap } from '@aegis/content';
import { coyoteGapPlugin } from '@aegis/game-platformer';

const assetRoot = new URL('../games/platformer/assets/', import.meta.url);
const atlas = JSON.parse(readFileSync(new URL('atlas.json', assetRoot), 'utf8'));
const sceneResult = parseScene(
  readFileSync(
    new URL('../games/platformer/levels/coyote-gap.scene.json', import.meta.url),
    'utf8',
  ),
);
if (!sceneResult.ok || sceneResult.value === undefined)
  throw new DiagnosticError(sceneResult.diagnostics);
const tilemapResult = parseTilemap(
  JSON.stringify(sceneResult.value.resources?.['platformer.tilemap']),
);
if (!tilemapResult.ok || tilemapResult.value === undefined)
  throw new DiagnosticError(tilemapResult.diagnostics);
const tilemap = tilemapResult.value;
const collision = tilemap.layers.find((layer) => layer.name === 'collision');
if (collision === undefined) throw new Error('[coyote-gap] The collision layer is required.');

const original = {
  author: 'Aegis / original Coyote Gap art',
  license: 'MIT',
  source: 'source/generate.mjs; provenance.json',
};

/** @returns {import('@aegis/render-three/presentation/schema').AssetSpec} */
function sheet(id) {
  const source = atlas.textures[id];
  if (source === undefined) throw new Error(`[coyote-gap] Missing original atlas "${id}".`);
  return {
    id,
    kind: 'texture',
    src: source.file,
    provenance: original,
    ...(source.frames === undefined
      ? {}
      : {
          frames: Object.fromEntries(
            Object.entries(source.frames).map(([name, rect]) => [
              name,
              [
                rect.x / source.width,
                rect.y / source.height,
                (rect.x + rect.width) / source.width,
                (rect.y + rect.height) / source.height,
              ],
            ]),
          ),
        }),
  };
}

/** @returns {import('@aegis/render-three/presentation/schema').AssetSpec} */
function terrainAsset(name) {
  return {
    id: `terrain-${name}`,
    kind: 'texture',
    src: atlas.textures.terrain.standalone[name],
    provenance: original,
  };
}

/** @returns {import('@aegis/render-three/presentation/schema').AssetSpec} */
function audioAsset(name) {
  return {
    id: name,
    kind: 'audio',
    src: `${name}.wav`,
    provenance: { ...original, source: 'source/generate-audio.mjs; provenance.json' },
  };
}

const terrainNames = [
  'rock-0',
  'rock-1',
  'rock-2',
  'rock-3',
  'edge',
  'girder',
  'panel',
  'warning',
  'grating',
  'spikes',
  'lava',
];
/** @type {Map<string, import('@aegis/render-three/presentation/schema').Pose[]>} */
const terrainInstances = new Map();
const solid = (col, row) => tilemap.legend[collision.data[row]?.[col]]?.solid === true;

// The painting follows the collision cells, never a second hand-maintained level layout.
for (let row = 0; row < tilemap.height; row++) {
  for (let col = 0; col < tilemap.width; col++) {
    if (!solid(col, row)) continue;
    const top = !solid(col, row - 1);
    const dock = (col >= 17 && col < 20) || (col >= 27 && col < 30);
    const material =
      col === tilemap.width - 1
        ? 'panel'
        : top
          ? dock
            ? 'girder'
            : 'edge'
          : `rock-${(col * 7 + row * 3) % 4}`;
    const instances = terrainInstances.get(material) ?? [];
    instances.push({
      position: [
        (col + 0.5) * tilemap.tileSize,
        (tilemap.height - row - 0.5) * tilemap.tileSize,
        0.1,
      ],
      scale: [tilemap.tileSize, tilemap.tileSize, 1],
    });
    terrainInstances.set(material, instances);
  }
}

/** @returns {import('@aegis/render-three/presentation/schema').Decoration} */
function prop(id, frame, position, height) {
  return {
    id,
    visual: { kind: 'sprite', texture: 'machinery', frame },
    pose: { position, scale: [height * 0.75, height, 1] },
  };
}

const heroPixel = 0.008;
const beetlePixel = 0.009;
const deckPixel = 3 / (atlas.textures.ferry.deck.right - atlas.textures.ferry.deck.left);

/** @type {import('@aegis/render-three/presentation/schema').PresentationSource} */
export const coyotePresentation = {
  assetRoot: fileURLToPath(assetRoot),
  manifest: {
    aegis: 'presentation/1',
    assets: [
      {
        id: 'canyon',
        kind: 'texture',
        src: 'canyon-vista.jpg',
        provenance: {
          ...original,
          source:
            'Original gpt-image-2 background; source/canyon-vista.prompt.txt; provenance.json',
        },
      },
      ...[
        'engineer',
        'critter',
        'ferry',
        'beacon',
        'machinery',
        'midground',
        'foreground',
        'effects',
      ].map(sheet),
      ...terrainNames.map(terrainAsset),
      ...['jump', 'landing', 'stomp', 'ferry', 'beacon', 'fall', 'canyon-air'].map((name) => ({
        ...audioAsset(name),
        id: `sound-${name}`,
      })),
    ],
    materials: [
      ...terrainNames.map((name) => ({
        id: `surface-${name}`,
        shading: /** @type {'unlit'} */ ('unlit'),
        map: `terrain-${name}`,
        alphaTest: 0.01,
        doubleSided: true,
      })),
      { id: 'haze', shading: 'unlit', opacity: 0.38 },
      { id: 'dust', shading: 'unlit', opacity: 0.8 },
      { id: 'signal', shading: 'unlit', opacity: 0.65 },
      { id: 'track', shading: 'unlit', color: '#74908b' },
    ],
    surfaces: { wall: 'surface-rock-0', hazard: 'surface-warning' },
    legacy: { level: false, triggers: false },
    environment: { background: '#243e4c' },
    entities: [
      {
        target: { name: 'player' },
        visual: {
          kind: 'sprite',
          texture: 'engineer',
          frame: 'idle-0',
          animations: {
            idle: { frames: ['idle-0', 'idle-1'], frameTicks: 32 },
            move: { frames: ['run-0', 'run-1', 'run-2', 'run-3', 'run-4', 'run-5'], frameTicks: 5 },
            rise: { frames: ['jump'], frameTicks: 1 },
            fall: { frames: ['fall'], frameTicks: 1 },
            dead: { frames: ['hurt'], frameTicks: 1 },
          },
        },
        fit: 'authored',
        pose: {
          position: [0, (atlas.textures.engineer.anchor.y - 96) * heroPixel - 0.5, 0.65],
          scale: [160 * heroPixel, 192 * heroPixel, 1],
        },
      },
      {
        target: { name: 'critter' },
        visual: {
          kind: 'sprite',
          texture: 'critter',
          frame: 'walk-0',
          animations: {
            idle: { frames: ['walk-0'], frameTicks: 1 },
            move: { frames: ['walk-0', 'walk-1', 'walk-2', 'walk-3'], frameTicks: 6 },
            dead: { frames: ['stomped'], frameTicks: 1 },
          },
        },
        fit: 'authored',
        pose: {
          position: [0, (atlas.textures.critter.anchor.y - 64) * beetlePixel - 0.4, 0.65],
          scale: [128 * beetlePixel, 128 * beetlePixel, 1],
        },
      },
      {
        target: { name: 'platform' },
        visual: { kind: 'sprite', texture: 'ferry' },
        fit: 'authored',
        pose: {
          position: [0, 0.5 - (96 - atlas.textures.ferry.deck.top) * deckPixel, 0.65],
          scale: [512 * deckPixel, 192 * deckPixel, 1],
        },
      },
      {
        target: { name: 'goal' },
        visual: { kind: 'sprite', texture: 'beacon', frame: 'idle' },
        fit: 'authored',
        pose: {
          position: [0, (329 / 352 - 0.5) * 3 - 1, 0.4],
          scale: [(256 / 352) * 3, 3, 1],
        },
      },
      // These paintings fill the actual lethal volumes up to the deck, not just the bottom tiles.
      {
        target: { name: 'hazard-pit' },
        visual: { kind: 'sprite', texture: 'terrain-spikes' },
        fit: 'bounds',
        pose: { position: [0, 0, -0.85] },
      },
      {
        target: { name: 'hazard-lava' },
        visual: { kind: 'sprite', texture: 'terrain-lava' },
        fit: 'bounds',
        pose: { position: [0, 0, -0.85] },
      },
    ],
    objects: [
      {
        id: 'canyon-vista',
        visual: { kind: 'sprite', texture: 'canyon' },
        anchor: 'camera',
        pose: { position: [0, 1, -70], scale: [36, 24, 1] },
      },
      {
        id: 'distant-works',
        visual: { kind: 'sprite', texture: 'midground' },
        parallax: 0.35,
        pose: { position: [23, -3, -14], scale: [84, 35, 1] },
      },
      {
        id: 'sunlit-air',
        visual: { kind: 'sprite', texture: 'effects', frame: 'ember-glow', material: 'haze' },
        anchor: 'camera',
        pose: { position: [7, 6, -46], scale: [22, 18, 1] },
      },
      ...[...terrainInstances].map(([name, instances]) => ({
        id: `cliff-${name}`,
        visual: /** @type {import('@aegis/render-three/presentation/schema').VisualSpec} */ ({
          kind: 'primitive',
          shape: 'plane',
          material: `surface-${name}`,
        }),
        instances,
      })),
      prop('departure-turbine', 'turbine', [0.8, 6.85, -0.4], 4),
      prop('departure-route', 'direction', [5.7, 6.05, -0.2], 2.3),
      prop('plateau-compressor', 'compressor', [12.5, 6.65, -0.2], 3.5),
      prop('left-ferry-gantry', 'gantry', [18.7, 7.6, -0.4], 5.4),
      prop('right-ferry-gantry', 'gantry', [28.2, 7.6, -0.4], 5.4),
      prop('far-route', 'direction', [35.6, 6.05, -0.2], 2.3),
      prop('beacon-works', 'compressor', [44.6, 7.4, -0.3], 3),
      {
        id: 'ferry-rail',
        visual: { kind: 'primitive', shape: 'plane', material: 'track' },
        pose: { position: [23.5, 4.31, 0.25], scale: [7, 0.035, 1] },
      },
      {
        id: 'dock-markings',
        visual: { kind: 'primitive', shape: 'plane', material: 'surface-warning' },
        instances: [
          { position: [6.92, 4.68, 0.2], scale: [0.16, 0.64, 1] },
          { position: [10.08, 4.68, 0.2], scale: [0.16, 0.64, 1] },
          { position: [19.92, 4.68, 0.2], scale: [0.16, 0.64, 1] },
          { position: [27.08, 4.68, 0.2], scale: [0.16, 0.64, 1] },
          { position: [36.92, 4.68, 0.2], scale: [0.16, 0.64, 1] },
          { position: [39.08, 4.68, 0.2], scale: [0.16, 0.64, 1] },
        ],
      },
      {
        id: 'beacon-deck',
        visual: { kind: 'primitive', shape: 'plane', material: 'surface-grating' },
        pose: { position: [43.5, 5.88, 0.2], scale: [3, 0.24, 1] },
      },
      {
        id: 'signal-halo',
        visual: { kind: 'sprite', texture: 'effects', frame: 'signal-glow', material: 'signal' },
        pose: { position: [43.5, 8, 0.3], scale: [2.8, 2.8, 1] },
        motion: { kind: 'pulse', axis: 'x', amplitude: 0.07, periodTicks: 110 },
      },
      {
        id: 'landing-dust',
        visual: { kind: 'sprite', texture: 'effects', frame: 'clear', material: 'dust' },
        anchor: { entity: 'player' },
        pose: { position: [0, -0.72, 0.8], scale: [1.4, 0.65, 1] },
      },
      {
        id: 'stomp-flash',
        visual: { kind: 'sprite', texture: 'effects', frame: 'clear' },
        anchor: { entity: 'critter' },
        pose: { position: [0, 0.12, 0.8], scale: [1.4, 1.4, 1] },
      },
      {
        id: 'ferry-lamp',
        visual: { kind: 'sprite', texture: 'effects', frame: 'signal-glow', material: 'signal' },
        anchor: { entity: 'platform' },
        pose: { position: [0, -0.03, 0.7], scale: [1.25, 0.5, 1] },
      },
      {
        id: 'near-canyon',
        visual: { kind: 'sprite', texture: 'foreground' },
        parallax: 0.1,
        pose: { position: [23, 8, 0.95], scale: [90, 30, 1] },
      },
    ],
    effects: [
      {
        event: 'player.jumped',
        kind: 'burst',
        target: { object: 'landing-dust' },
        color: '#f4d3a1',
        count: 4,
        amount: 0.12,
        durationTicks: 12,
      },
      {
        event: 'player.landed',
        kind: 'frames',
        target: { object: 'landing-dust' },
        frames: ['dust-0', 'dust-1', 'dust-2', 'dust-3', 'clear'],
        frameTicks: 2,
        durationTicks: 10,
      },
      {
        event: 'enemy.killed',
        kind: 'frames',
        target: { entity: 'critter' },
        frames: ['stomped', 'clear'],
        frameTicks: 10,
        durationTicks: 12,
        holdLast: true,
      },
      {
        event: 'enemy.killed',
        kind: 'frames',
        target: { object: 'stomp-flash' },
        frames: ['impact', 'spark', 'clear'],
        frameTicks: 3,
        durationTicks: 9,
      },
      {
        event: 'platform.boarded',
        kind: 'pulse',
        target: { object: 'ferry-lamp' },
        color: '#c9ffe7',
        amount: 0.4,
        durationTicks: 24,
      },
      {
        event: 'level.completed',
        kind: 'frames',
        target: { entity: 'goal' },
        frames: ['active'],
        frameTicks: 1,
        durationTicks: 1,
        holdLast: true,
      },
      {
        event: 'level.completed',
        kind: 'frames',
        target: { entity: 'player' },
        frames: ['win-0', 'win-1', 'win-2'],
        frameTicks: 8,
        durationTicks: 24,
        holdLast: true,
      },
      {
        event: 'level.completed',
        kind: 'burst',
        target: { object: 'signal-halo' },
        color: '#b5f3d4',
        count: 14,
        amount: 0.18,
        durationTicks: 56,
      },
      {
        event: 'player.died',
        kind: 'frames',
        target: { entity: 'player' },
        frames: ['hurt'],
        frameTicks: 1,
        durationTicks: 1,
        holdLast: true,
      },
    ],
    audio: {
      volume: 0.7,
      ambient: { asset: 'sound-canyon-air', volume: 0.42 },
      cues: [
        { event: 'player.jumped', asset: 'sound-jump', volume: 0.5, cooldownTicks: 4 },
        { event: 'player.landed', asset: 'sound-landing', volume: 0.52, cooldownTicks: 5 },
        { event: 'enemy.killed', asset: 'sound-stomp', volume: 0.64 },
        { event: 'platform.boarded', asset: 'sound-ferry', volume: 0.7 },
        { event: 'level.completed', asset: 'sound-beacon', volume: 0.8 },
        { event: 'player.died', asset: 'sound-fall', volume: 0.7 },
      ],
    },
    ui: { accent: '#efb86a', eyebrow: 'The Amber Traverse', cover: 'canyon' },
    hud: {
      playerName: 'player',
      winEvent: 'level.completed',
      loseEvents: ['player.died'],
      steps: [
        { id: 'patrol', label: 'Stomp the furnace beetle', event: 'enemy.killed' },
        { id: 'ferry', label: 'Board and ride the ferry', event: 'platform.boarded' },
        { id: 'beacon', label: 'Light the far beacon', event: 'level.completed' },
      ],
    },
  },
};

/** Game-owned composition. Asset URLs and visual mappings never enter the simulation scene. */
export const platformer = {
  id: 'platformer',
  title: 'Coyote Gap',
  blurb: 'An engineer, a furnace beetle and a rail ferry above a sunlit industrial canyon.',
  objective: 'Stomp the beetle, ride the ferry, then leap to the far beacon.',
  plugin: coyoteGapPlugin,
  pluginModule: '@aegis/game-platformer',
  pluginExport: 'coyoteGapPlugin',
  packageDir: 'games/platformer',
  scene: 'games/platformer/levels/coyote-gap.scene.json',
  script: 'games/platformer/play/coyote-gap.input',
  scriptTicks: 400,
  acceptance: { winEvent: 'level.completed', playerName: 'player' },
  presentation: coyotePresentation,
};
