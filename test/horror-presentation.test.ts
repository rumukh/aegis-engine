import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScene } from '@aegis/content';
import { bootstrapScene } from '@aegis/harness';
import { horror, horrorBindings } from '../poc/horror.mjs';
import { pocGames, pocStaticGames } from '../poc/poc-games.mjs';
import { preparePresentation } from '../packages/render-three/src/presentation/files.js';
import { validatePresentation } from '../packages/render-three/src/presentation/validate.js';
import { validatePresentationWorld } from '../packages/render-three/src/presentation/world.js';

const inventory = JSON.parse(
  readFileSync('games/horror/assets/generated/inventory.json', 'utf8'),
) as {
  sourceScene: { floorplanSha256: string };
  budget: { totalBytes: number };
  files: { file: string; bytes: number; sha256: string }[];
  placement: { doors: { entity: string; cells: [number, number][]; event: string }[] };
};
const parsed = parseScene(readFileSync(horror.scene, 'utf8'));
assert.ok(parsed.ok && parsed.value);
const scene = parsed.value;
const retiredResponderFiles = [
  'insert-basecolor.jpg',
  'insert-normal.png',
  'insert-orm.png',
  'rescue-badges.png',
  'responder-contact-stains-orm.png',
  'responder-contact-stains.png',
  'responder.glb',
  'suit-shell-basecolor.png',
  'suit-shell-normal.png',
  'suit-shell-orm.png',
  'suit-textile-basecolor.png',
  'suit-textile-orm.png',
];
const responderModel = 'imported/responder-trellis/model/responder.glb';

describe('NULL MERIDIAN integrated asset and controller contract', () => {
  it('retains nine immutable authoring and provenance JSONs with independent fingerprints', () => {
    // Frozen production receipts and inputs, not hashes derived from the files under test.
    const records = [
      [
        'generated/prototype-provenance.json',
        '7f1f548c597bcab4aa4f017fe3da18c12b50ac29d3fb6fda205ad507595c1b8b',
      ],
      [
        'generated/sculpt-provenance.json',
        '7f1f548c597bcab4aa4f017fe3da18c12b50ac29d3fb6fda205ad507595c1b8b',
      ],
      [
        'generated/suit-damage-provenance.json',
        '06638fdd8cba2e3b268b8f7bf46ad769ec148271cc7bc4e45d1b077623d1fe06',
      ],
      [
        'source/sculpt-input/inventory.json',
        '519ec34a7499f26918b9479060d9aa421411c915f4b95c74464bdfc9ae33840c',
      ],
      [
        'source/sculpt-insert/basecolor-cook.json',
        'fbd365f8170f9d0fc5090f139184bc0dcb88554b834413fd76e66773b695fdfd',
      ],
      [
        'source/sculpt-insert/sculpt-provenance.json',
        '5232b8354b482113fd77a09a7af81ce7f82cfeff4df52648fc33bdfc041c5ac3',
      ],
      [
        'source/aftermath-input/baseline-inventory.json',
        'cf108f958647514f19e3933a176abdf32612fbf672f50678d7005d9aa06d3eff',
      ],
      [
        'source/aftermath-input/baseline-presentation.json',
        'f7c2bd9fbb6b8f5b538124043ebf45908de941d7a9e72b9bb8baa4275004c41a',
      ],
      [
        'source/aftermath-input/placement-contract.json',
        'b7d53f1ad3d7a5b82982521c8ad0c5b4224624691d3a79efa62737a16834251e',
      ],
    ] as const;
    for (const [file, expected] of records) {
      const text = readFileSync(join('games', 'horror', 'assets', ...file.split('/')), 'utf8');
      expect(() => JSON.parse(text), file).not.toThrow();
      expect(createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex'), file).toBe(
        expected,
      );
    }
  });

  it('the horror presentation revision preserves the canonical scene and all three input routes', () => {
    // Pinned from 5e9cdcdbc before the infestation pass; normalize checkout line endings only.
    const unchanged = [
      [
        'games/horror/levels/null-meridian.scene.json',
        'd25e8c7f285a35618c9948625874e7eb24186f62759a89717a1b803cce969e10',
      ],
      [
        'games/horror/play/null-meridian.input',
        'bc5c4a2ef9b4fb6190195d1503085206e68ea2e2c3baa5b7fc097f9369de9691',
      ],
      [
        'games/horror/play/caught.input',
        'c1c0e237929466bec47eb005d6ad6e28c6b92db5ceec9e8dcc19c2c41d887fd3',
      ],
      [
        'games/horror/play/locked.input',
        '656ccd157c72c85a0a23a94520ec348f6dc970c6c6dc4096eb17849728ea26f0',
      ],
    ] as const;
    for (const [file, expected] of unchanged) {
      const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
      expect(createHash('sha256').update(text).digest('hex'), file).toBe(expected);
    }
  });

  it('ships eight voice, nineteen foley and three approved sparse horror files with verified hashes and no score', () => {
    const cues: { id: string; url: string; sha256: string }[] = [];
    for (const [name, expected] of [
      ['voices', 8],
      ['foley', 19],
      ['horror-layers', 3],
    ] as const) {
      const audio = JSON.parse(readFileSync(`games/horror/assets/audio/${name}.json`, 'utf8')) as {
        cues: { id: string; url: string; sha256: string }[];
      };
      expect(audio.cues, name).toHaveLength(expected);
      cues.push(...audio.cues);
    }
    expect(new Set(cues.map((cue) => cue.id)).size).toBe(30);
    for (const cue of cues) {
      const bytes = readFileSync(join('games', 'horror', 'assets', 'audio', ...cue.url.split('/')));
      expect(createHash('sha256').update(bytes).digest('hex'), cue.id).toBe(cue.sha256);
    }
    const prepared = preparePresentation(horror.presentation, scene);
    expect(prepared.files.map((file) => file.path).sort()).toEqual(
      [
        ...inventory.files
          .filter((file) => !retiredResponderFiles.includes(file.file))
          .map((file) => `generated/${file.file}`),
        responderModel,
        'generated/evacuation-ending.glb',
        ...cues.map((cue) => `audio/${cue.url}`),
      ].sort(),
    );
    expect(horror.presentation.manifest.audio?.headroom).toBe(0.65);
    expect(
      horror.presentation.manifest.assets?.some((asset) => asset.id.startsWith('score-')),
    ).toBe(false);
  });
  it('the cooked environment fingerprints the actual authoritative collision floorplan', () => {
    const hash = createHash('sha256')
      .update(JSON.stringify(scene.resources?.['fps.floorplan']))
      .digest('hex');
    expect(hash).toBe(inventory.sourceScene.floorplanSha256);
    expect(inventory.files).toHaveLength(45);
    let bytes = 0;
    for (const file of inventory.files) {
      const data = readFileSync(join('games', 'horror', 'assets', 'generated', file.file));
      expect(createHash('sha256').update(data).digest('hex'), file.file).toBe(file.sha256);
      expect(data.length, file.file).toBe(file.bytes);
      bytes += data.length;
    }
    expect(bytes).toBe(inventory.budget.totalBytes);
    expect(bytes).toBeLessThan(48 * 1024 * 1024);
  });

  it('loads a closed non-placeholder visual/audio manifest within the unchanged engine budget', () => {
    const manifest = horror.presentation.manifest;
    expect(validatePresentation(manifest).diagnostics).toEqual([]);
    const { world } = bootstrapScene(scene, { plugin: horror.plugin });
    expect(validatePresentationWorld(manifest, world).diagnostics).toEqual([]);
    const prepared = preparePresentation(horror.presentation, scene);
    expect(prepared.files).toHaveLength(65);
    expect(prepared.totalBytes).toBe(42_433_448);
    expect(prepared.totalBytes).toBeLessThan(64 * 1024 * 1024);
    const visualBytes = prepared.files
      .filter((file) => !file.path.startsWith('audio/'))
      .reduce((sum, file) => sum + file.bytes, 0);
    const audioBytes = prepared.totalBytes - visualBytes;
    expect(visualBytes).toBeLessThanOrEqual(50 * 1024 * 1024);
    expect(audioBytes).toBeLessThanOrEqual(14 * 1024 * 1024);
    const files = prepared.files.map((file) => file.path);
    expect(files).toContain('generated/facility.glb');
    expect(files).toContain('generated/orbital-exterior.glb');
    expect(files).toContain(responderModel);
    for (const file of retiredResponderFiles) expect(files).not.toContain(`generated/${file}`);
    expect(files).toContain('generated/struggle.glb');
    expect(files).toContain('generated/aftermath-sites.glb');
    expect(files).toContain('generated/suit-textile-normal.png');
    expect(files).not.toContain('source/trellis-monster/approved-concept.png');
    expect(files).not.toContain('imported/responder-trellis/import.json');
    expect(files).toContain('generated/colony-shell-normal.png');
    expect(files).not.toContain('generated/colony-shell-basecolor.png');
    expect(files).not.toContain('generated/colony-shell-orm.png');
    expect(files).not.toContain('source/sculpt-insert/infestation-sculpt.blend');
    expect(files).toContain('audio/runtime/vo-recorder.ogg');
    expect(files).toContain('audio/runtime/dread-membrane.ogg');
    expect(files).toContain('audio/runtime/dread-chitter.ogg');
    expect(files).toContain('audio/runtime/responder-breath.ogg');
    expect(files).not.toContain('source/observation-concept.png');
    expect(manifest.legacy).toEqual({ level: false, triggers: false });
    expect(manifest.assets?.find((asset) => asset.id === 'responder')?.provenance.source).toBe(
      'games/horror/assets/source/trellis-monster/recipe.json',
    );
  });

  it('keeps horror layers sparse, localized and disabled during pursuit and either ending', () => {
    const audio = horror.presentation.manifest.audio;
    expect(audio?.layers).toHaveLength(6);
    const ids = ['dread-membrane', 'dread-chitter', 'responder-breath'];
    const layers = audio?.layers?.filter((layer) => ids.includes(layer.id)) ?? [];
    expect(layers.map((layer) => layer.id)).toEqual(ids);
    expect(layers.map((layer) => layer.volume)).toEqual([0.3, 0.26, 0.22]);
    expect(layers.map((layer) => layer.spatial?.target)).toEqual([
      { position: [4.7, 1.4, 16] },
      { position: [29.6, 2.3, 16.5] },
      { entity: 'responder' },
    ]);
    for (const layer of layers) {
      expect(layer.fadeSeconds).toBe(0.2);
      expect(layer.enabledWhen).toEqual({
        entity: 'player',
        component: 'HorrorStatus',
        field: 'musicPhase',
        equals: 'explore',
      });
    }
    expect(audio?.cues?.filter((cue) => ids.includes(cue.asset ?? ''))).toEqual([]);
    expect(audio?.cues?.filter((cue) => cue.event === 'horror.threat.step')).toHaveLength(3);
    expect(audio?.cues?.find((cue) => cue.event === 'horror.threat.warning')?.asset).toBe(
      'threat-alert',
    );
    const source = JSON.parse(
      readFileSync('games/horror/assets/audio/horror-layers.json', 'utf8'),
    ) as {
      cues: { channels: number; durationSeconds: number; quietFraction: number }[];
      decodedFloatPcmBytes: number;
    };
    expect(source.cues.map((cue) => cue.durationSeconds)).toEqual([37, 41, 47]);
    expect(source.cues.every((cue) => cue.channels === 1 && cue.quietFraction >= 0.85)).toBe(true);
    expect(source.decodedFloatPcmBytes).toBe(24_000_000);
  });

  it('mounts struggle evidence as presentation only and preserves the accepted orbital optics', () => {
    expect(horror.presentation.manifest.objects).toContainEqual({
      id: 'struggle',
      visual: { kind: 'model', mesh: 'struggle' },
      pose: { position: [0, 0, 0] },
    });
    expect(scene.entities.some((entity) => entity.id === 'struggle')).toBe(false);
    expect(inventory.files.find((file) => file.file === 'orbital-exterior.glb')?.sha256).toBe(
      'c39e043aa25548dd9bc69db434291e7d4e78bb645628076a4f93604e0b6d8f5e',
    );
    expect(inventory.files.find((file) => file.file === 'ring-density.png')?.sha256).toBe(
      '3c699294d7c94b5df847a46e794208aa9fc401f04dfc05f5fafaa0e9bf839434',
    );
  });

  it('mounts three additional aftermath sites without authoritative anchors', () => {
    const manifest = horror.presentation.manifest;
    expect(manifest.objects?.filter((object) => object.id === 'aftermath-sites')).toEqual([
      {
        id: 'aftermath-sites',
        visual: { kind: 'model', mesh: 'aftermath-sites' },
        pose: { position: [0, 0, 0] },
      },
    ]);
    expect(
      manifest.assets?.find((asset) => asset.id === 'aftermath-sites')?.provenance.source,
    ).toBe('games/horror/assets/source/aftermath-three.recipe.json');
    const bytes = readFileSync('games/horror/assets/generated/aftermath-sites.glb');
    expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
    const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as {
      nodes: { name: string }[];
    };
    expect(gltf.nodes.map((node) => node.name)).toEqual([
      'null-meridian-three-aftermath-sites',
      'arrival-aftermath',
      'arrival-aftermath-floor',
      'infirmary-aftermath',
      'infirmary-aftermath-floor',
      'archive-aftermath',
      'archive-aftermath-floor',
    ]);
    for (const id of [
      'aftermath-sites',
      'arrival-aftermath',
      'infirmary-aftermath',
      'archive-aftermath',
    ])
      expect(
        scene.entities.some((entity) => entity.id === id),
        id,
      ).toBe(false);
  });

  it('all six three-cell doors and eleven interactions have authored visuals', () => {
    const manifest = horror.presentation.manifest;
    expect(inventory.placement.doors).toHaveLength(6);
    expect(inventory.placement.doors.flatMap((door) => door.cells)).toHaveLength(18);
    for (const entity of scene.entities.filter(
      (entry) => entry.components?.['HorrorInteractable'],
    )) {
      expect(
        manifest.entities?.some(
          (binding) => 'name' in binding.target && binding.target.name === entity.id,
        ),
        entity.id,
      ).toBe(true);
    }
    for (const door of inventory.placement.doors) {
      expect(
        manifest.effects?.some(
          (effect) =>
            effect.event === door.event &&
            'entity' in effect.target &&
            effect.target.entity === door.entity &&
            effect.clip === 'Open' &&
            effect.holdLast,
        ),
        door.entity,
      ).toBe(true);
    }
  });

  it('dev and static use the same per-entry noncombat bindings rather than the stock FPS fire mapping', async () => {
    const live = (await pocGames()).find((game) => game.id === 'horror');
    const shipped = (await pocStaticGames()).find((game) => game.id === 'horror');
    expect(live?.bindings).toEqual(horrorBindings);
    expect(shipped?.bindings).toEqual(horrorBindings);
    expect(horrorBindings.actions).toContainEqual({ code: 'KeyE', action: 'Interact' });
    expect(horrorBindings.actions).toContainEqual({ code: 'KeyQ', action: 'Select' });
    expect(horrorBindings.actions).toContainEqual({ code: 'KeyC', action: 'Crouch' });
    expect(horrorBindings.actions.some((binding) => binding.code === 'ControlLeft')).toBe(false);
    expect(
      horrorBindings.actions.some(
        (binding) => binding.action === 'Fire' || binding.action === 'Jump',
      ),
    ).toBe(false);
    expect(horrorBindings.gamepad?.bindings.buttons).toContainEqual({
      button: 0,
      action: 'Interact',
      label: 'A',
    });
    expect(horrorBindings.gamepad?.bindings.buttons).toContainEqual({
      button: 2,
      action: 'Select',
      label: 'X',
    });
    expect(horrorBindings.gamepad?.commands).toEqual({
      SessionPause: 'pause',
      SessionRestart: 'restart',
    });
  });

  it('HUD, light and animation choices reference initialized simulation state without renderer mutation', () => {
    const manifest = horror.presentation.manifest;
    expect(manifest.hud?.bindings?.prompt).toEqual({
      entity: 'player',
      component: 'HorrorStatus',
      field: 'prompt',
    });
    expect(
      manifest.environment?.spots?.find((light) => light.id === 'suit-flashlight')?.enabledWhen,
    ).toEqual({
      entity: 'player',
      component: 'HorrorPlayer',
      field: 'flashlight',
      equals: true,
    });
    expect(manifest.environment?.spots).toHaveLength(8);
    expect(manifest.environment?.spots?.filter((light) => light.shadow)).toHaveLength(2);
    expect(manifest.pipeline?.ambientOcclusion).toBeUndefined();
    expect(manifest.quality).toBe('high');
    expect(manifest.ui?.lossEnding).toEqual({
      title: 'YOU WERE CAUGHT',
      message: 'The responder caught you. Restart from the docking airlock.',
      fadeSeconds: 1,
    });
    expect(manifest.hud?.loseEvents).toEqual(['player.died']);
    expect(manifest.ui?.winEnding?.model).toBe('evacuation-ending');
    expect(manifest.ui?.winEnding?.cues).toEqual([
      { atSeconds: 4, event: 'presentation.evacuation.separated' },
    ]);
    expect(manifest.audio?.cues?.filter((cue) => cue.asset === 'vo-exit')).toEqual([
      expect.objectContaining({ event: 'presentation.evacuation.separated' }),
    ]);
  });
});
