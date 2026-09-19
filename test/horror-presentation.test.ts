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

describe('NULL MERIDIAN integrated asset and controller contract', () => {
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
        ...inventory.files.map((file) => `generated/${file.file}`),
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
    expect(inventory.files).toHaveLength(36);
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
    expect(prepared.files).toHaveLength(67);
    expect(prepared.totalBytes).toBe(41_612_440);
    expect(prepared.totalBytes).toBeLessThan(64 * 1024 * 1024);
    const files = prepared.files.map((file) => file.path);
    expect(files).toContain('generated/facility.glb');
    expect(files).toContain('generated/orbital-exterior.glb');
    expect(files).toContain('generated/responder.glb');
    expect(files).toContain('audio/runtime/vo-recorder.ogg');
    expect(files).toContain('audio/runtime/dread-membrane.ogg');
    expect(files).toContain('audio/runtime/dread-chitter.ogg');
    expect(files).toContain('audio/runtime/responder-breath.ogg');
    expect(files).not.toContain('source/observation-concept.png');
    expect(manifest.legacy).toEqual({ level: false, triggers: false });
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
