import { nullMeridianPlugin } from '@aegis/game-horror';
import { BINDINGS } from '@aegis/render-three/input';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/** @type {import('@aegis/render-three/input').ModeBindings} */
export const horrorBindings = {
  ...BINDINGS.fps,
  actions: [
    { code: 'KeyE', action: 'Interact' },
    { code: 'KeyQ', action: 'Select' },
    { code: 'KeyF', action: 'Flashlight' },
    { code: 'KeyC', action: 'Crouch' },
    { code: 'ShiftLeft', action: 'Sprint' },
  ],
  primaryButtonAction: 'Interact',
  gamepad: {
    ...BINDINGS.fps.gamepad,
    bindings: {
      sticks: BINDINGS.fps.gamepad.bindings.sticks,
      buttons: [
        { button: 0, action: 'Interact', label: 'A' },
        { button: 1, action: 'Crouch', label: 'B' },
        { button: 2, action: 'Select', label: 'X' },
        { button: 3, action: 'Flashlight', label: 'Y' },
        { button: 4, action: 'Sprint', label: 'LB' },
        { button: 9, action: 'SessionPause', label: 'Menu' },
        { button: 8, action: 'SessionRestart', label: 'View' },
      ],
    },
  },
  help: [
    { keys: 'W A S D / left stick', does: 'move; no weapons' },
    { keys: 'mouse / right stick', does: 'look' },
    { keys: 'E / A (hold at machinery)', does: 'interact' },
    { keys: 'Q / X at a selector', does: 'choose a labeled circuit or evacuation authority' },
    { keys: 'C / B (hold)', does: 'crouch and move quietly' },
    { keys: 'Shift / LB (hold)', does: 'sprint; louder, limited stamina' },
    { keys: 'F / Y', does: 'toggle flashlight; darkness reduces detection' },
  ],
};

const visuals = JSON.parse(
  readFileSync(new URL('../games/horror/assets/generated/inventory.json', import.meta.url), 'utf8'),
);
const sound = JSON.parse(
  readFileSync(
    new URL('../games/horror/assets/audio/voices.presentation-fragment.json', import.meta.url),
    'utf8',
  ),
);
const foley = JSON.parse(
  readFileSync(
    new URL('../games/horror/assets/audio/foley.presentation-fragment.json', import.meta.url),
    'utf8',
  ),
);
const horrorSound = JSON.parse(
  readFileSync(
    new URL(
      '../games/horror/assets/audio/horror-layers.presentation-fragment.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const emitters = {
  'horror.service.opened': 'service-door',
  'horror.uplink.transmitted': 'evac-door',
  'horror.power.restored': 'power-console',
  'horror.coolant.isolated': 'coolant-valve',
};
const provenance = {
  author: 'Aegis contributors / original authored station and rescue responder',
  license: 'Original generated media; provenance.json records sources and human concept approval',
  source: 'games/horror/assets/generate.mjs',
};
const infestationProvenance = {
  author: 'Aegis contributors / original alien infestation and struggle evidence',
  license:
    'Original project-authored geometry and procedural maps; source/horror-pass.recipe.json records production provenance. Current approval context: docs/games/horror.md.',
  source: 'games/horror/assets/source/horror-pass.recipe.json',
};
const sculptProvenance = {
  author: 'Aegis contributors / original scripted Blender sculpt, UVs and baked materials',
  license:
    'Original project-authored insert and bounded suit damage; retained body maps preserve their existing provenance. Current approval context: docs/games/horror.md.',
  source: 'games/horror/assets/source/suit-damage.recipe.json',
};
const aftermathProvenance = {
  author: 'Aegis contributors / original localized station aftermath',
  license: 'Original project-authored geometry using unchanged existing material maps.',
  source: 'games/horror/assets/source/aftermath-three.recipe.json',
};
const modelId = (file) => file.replace(/\.glb$/, '');
const powered = { entity: 'mission', component: 'HorrorMission', field: 'power', equals: true };
const stateField = (field) => ({ entity: 'player', component: 'HorrorStatus', field });

/** @type {import('@aegis/render-three/presentation/schema').PresentationSource} */
export const horrorPresentation = {
  assetRoot: fileURLToPath(new URL('../games/horror/assets/', import.meta.url)),
  manifest: {
    aegis: 'presentation/1',
    quality: 'high',
    pipeline: {
      toneMapping: 'aces',
      exposure: 1.1,
      saturation: 0.94,
      bloom: { strength: 0.12, radius: 0.3, threshold: 1 },
    },
    assets: [
      ...sound.assets,
      ...foley.assets,
      ...horrorSound.assets,
      {
        id: 'evacuation-ending',
        kind: 'gltf',
        src: 'generated/evacuation-ending.glb',
        provenance: {
          author: 'Aegis contributors / original evacuation set and animation',
          license:
            'Original authored geometry; reused material provenance in assets/provenance.json',
          source: 'games/horror/assets/build-ending.mjs',
        },
      },
      ...visuals.models.map((model) => ({
        id: modelId(model.file),
        kind: 'gltf',
        src: `generated/${model.file}`,
        provenance:
          model.file === 'responder.glb'
            ? sculptProvenance
            : model.file === 'struggle.glb'
              ? infestationProvenance
              : model.file === 'aftermath-sites.glb'
                ? aftermathProvenance
                : provenance,
      })),
      {
        id: 'station-reflection',
        kind: 'texture',
        src: 'generated/station-reflection.png',
        colorSpace: 'srgb',
        provenance,
      },
    ],
    audio: {
      volume: 1,
      headroom: 0.65,
      layers: [
        ...foley.audio.layers.map((layer) => ({
          ...layer,
          ...(['amb-room', 'amb-hull'].includes(layer.id)
            ? {
                enabledWhen: {
                  entity: 'player',
                  component: 'HorrorStatus',
                  field: 'ended',
                  equals: false,
                },
              }
            : {}),
          ...(layer.id === 'amb-vent'
            ? { spatial: { ...layer.spatial, target: { entity: 'power-console' } } }
            : {}),
        })),
        ...horrorSound.audio.layers,
      ],
      cues: [
        ...sound.audio.cues.map((cue) =>
          cue.asset === 'vo-exit' ? { ...cue, event: 'presentation.evacuation.separated' } : cue,
        ),
        ...foley.audio.cues.map((cue) => ({
          ...cue,
          ...(emitters[cue.event]
            ? { spatial: { ...cue.spatial, target: { entity: emitters[cue.event] } } }
            : {}),
        })),
      ],
    },
    legacy: { level: false, triggers: false },
    objects: [
      { id: 'facility', visual: { kind: 'model', mesh: 'facility' } },
      { id: 'orbital-exterior', visual: { kind: 'model', mesh: 'orbital-exterior' } },
      {
        id: 'struggle',
        visual: { kind: 'model', mesh: 'struggle' },
        pose: { position: [0, 0, 0] },
      },
      {
        id: 'aftermath-sites',
        visual: { kind: 'model', mesh: 'aftermath-sites' },
        pose: { position: [0, 0, 0] },
      },
    ],
    entities: [
      ...visuals.placement.props.map((prop) => ({
        target: { name: prop.entity },
        visual: { kind: 'model', mesh: modelId(prop.model) },
        pose: { rotation: prop.rotation },
        fit: 'authored',
      })),
      ...visuals.placement.doors.map((door) => ({
        target: { name: door.entity },
        visual: { kind: 'model', mesh: 'pressure-door' },
        pose: { rotation: door.rotation },
        fit: 'authored',
      })),
      {
        target: { name: 'responder' },
        fit: 'authored',
        visual: {
          kind: 'model',
          mesh: 'responder',
          clip: 'Idle',
          stateClips: [
            {
              when: { entity: 'player', component: 'HorrorStatus', field: 'ended', equals: true },
              clip: 'Idle',
            },
            {
              when: {
                entity: 'responder',
                component: 'HorrorThreat',
                field: 'mode',
                equals: 'dormant',
              },
              clip: 'Idle',
            },
            {
              when: {
                entity: 'responder',
                component: 'HorrorThreat',
                field: 'mode',
                equals: 'patrol',
              },
              clip: 'Stalk',
              timeScale: 1.58125,
            },
            {
              when: {
                entity: 'responder',
                component: 'HorrorThreat',
                field: 'mode',
                equals: 'chase',
              },
              clip: 'Stalk',
              timeScale: 3.64375,
            },
            {
              when: {
                entity: 'responder',
                component: 'HorrorThreat',
                field: 'path.length',
                equals: 0,
              },
              clip: 'Search',
            },
            {
              when: {
                entity: 'responder',
                component: 'HorrorThreat',
                field: 'mode',
                equals: 'search',
              },
              clip: 'Stalk',
              timeScale: 2.0625,
            },
          ],
        },
      },
    ],
    effects: [
      ...visuals.placement.doors.map((door) => ({
        event: door.event,
        kind: 'clip',
        target: { entity: door.entity },
        clip: 'Open',
        durationTicks: 42,
        holdLast: true,
      })),
      {
        event: 'horror.threat.warning',
        kind: 'clip',
        target: { entity: 'responder' },
        clip: 'Lunge',
        durationTicks: 48,
      },
    ],
    environment: {
      background: '#030509',
      ambient: { color: '#7c9292', intensity: 0.2 },
      reflections: { texture: 'station-reflection', intensity: 0.32 },
      // Local emergency-fixture bounce, not a global brightness lift or claimed GI.
      points: [
        { color: '#dfc39a', intensity: 10, position: [15, 2.9, 4], distance: 8 },
        { color: '#c9b18f', intensity: 8, position: [5, 2.9, 17], distance: 12 },
        { color: '#e4cca3', intensity: 10, position: [6, 2.9, 29], distance: 10 },
        { color: '#c0d1c8', intensity: 7, position: [26, 2.9, 14], distance: 10 },
        { color: '#c9bb9f', intensity: 8, position: [22, 2.9, 28], distance: 10 },
        { color: '#acc2c2', intensity: 8, position: [15, 2.9, 21], distance: 16 },
        { color: '#e4cbb0', intensity: 8, position: [15, 2.9, 37], distance: 14 },
        { color: '#c5d6cd', intensity: 6, position: [27, 2.9, 37], distance: 8 },
      ],
      spots: [
        ...visuals.suggestedLighting.spots.map(({ shadow, ...light }) => ({
          ...light,
          intensity: light.intensity * 2,
          penumbra: 0.55,
          ...(shadow ? { shadow: { mapSize: 2048, bias: -0.0001, normalBias: 0.025 } } : {}),
          ...(['archive-practical', 'infirmary-practical', 'observation-practical'].includes(
            light.id,
          )
            ? { enabledWhen: powered }
            : {}),
        })),
        {
          id: 'suit-flashlight',
          anchor: 'camera',
          color: '#dce8ee',
          intensity: 36,
          position: [0.18, -0.12, 0],
          target: [0.18, -0.12, -10],
          distance: 23,
          angle: 28,
          penumbra: 0.6,
          shadow: { mapSize: 2048, bias: -0.0001, normalBias: 0.02 },
          enabledWhen: {
            entity: 'player',
            component: 'HorrorPlayer',
            field: 'flashlight',
            equals: true,
          },
        },
      ],
    },
    ui: {
      layout: 'cinematic',
      accent: '#c5d8c8',
      eyebrow: 'NULL MERIDIAN / survival protocol',
      lossEnding: {
        title: 'YOU WERE CAUGHT',
        message: 'The responder caught you. Restart from the docking airlock.',
        fadeSeconds: 1,
      },
      winEnding: {
        model: 'evacuation-ending',
        clip: 'Departure',
        camera: { eye: 'ending-eye', target: 'ending-target', fov: 50 },
        title: 'CLEAR OF NULL MERIDIAN',
        message:
          'The crew archive is safe. The rescue network is behind you. You are free to leave.',
        fadeSeconds: 1.5,
        captions: [
          { startSeconds: 0, endSeconds: 3.6, text: 'INDEPENDENT CAPSULE / Hatch sealing.' },
          {
            startSeconds: 4,
            endSeconds: 8.5,
            text: 'Station: Separation confirmed. You are clear of the station.',
          },
          {
            startSeconds: 10.5,
            endSeconds: 14.5,
            text: 'CREW ARCHIVE / Receipt verified. Evidence preserved.',
          },
          {
            startSeconds: 14.5,
            endSeconds: 18,
            text: 'Your departure is not a medical emergency.',
          },
        ],
        cues: [{ atSeconds: 4, event: 'presentation.evacuation.separated' }],
      },
    },
    hud: {
      playerName: 'player',
      winEvent: 'level.completed',
      loseEvents: ['player.died'],
      bindings: {
        objective: stateField('objective'),
        prompt: stateField('prompt'),
        subtitle: stateField('subtitle'),
        subtitleUntil: stateField('subtitleUntil'),
        status: stateField('threat'),
      },
      steps: [
        { id: 'fuse', label: 'Find the auxiliary fuse', event: 'horror.fuse.taken' },
        { id: 'power', label: 'Restore auxiliary power', event: 'horror.power.restored' },
        {
          id: 'recorder',
          label: 'Recover the archive recorder',
          event: 'horror.recorder.recovered',
        },
        { id: 'coolant', label: 'Isolate coolant return', event: 'horror.coolant.isolated' },
        { id: 'uplink', label: 'Transmit from observation', event: 'horror.uplink.transmitted' },
        { id: 'escape', label: 'Seal the evacuation capsule', event: 'level.completed' },
      ],
    },
  },
};

export const horror = {
  id: 'horror',
  title: 'NULL MERIDIAN',
  blurb: 'An abandoned orbital facility. A rescue signal that should have stopped.',
  objective:
    'Find auxiliary power, recover the crew evidence, evade the responder, and escape. No weapons.',
  plugin: nullMeridianPlugin,
  pluginModule: '@aegis/game-horror',
  pluginExport: 'nullMeridianPlugin',
  packageDir: 'games/horror',
  scene: 'games/horror/levels/null-meridian.scene.json',
  script: 'games/horror/play/null-meridian.input',
  scriptTicks: 8217,
  acceptance: {
    winEvent: 'level.completed',
    playerName: 'player',
    photoEvent: 'horror.recorder.recovered',
  },
  bindings: horrorBindings,
  presentation: horrorPresentation,
};
