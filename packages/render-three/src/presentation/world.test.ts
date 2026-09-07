import { describe, expect, it } from 'vitest';
import { createWorld, Name } from '@aegis/core';
import { validatePresentationWorld } from './world.js';
import type { PresentationManifest } from './schema.js';

describe('presentation targets in initialized worlds', () => {
  it('accepts qualified and init-created names without mutating the world', () => {
    const world = createWorld({ seed: 'presentation-names' });
    world.add(world.spawn(), Name, { value: 'root/child~1part' });
    world.add(world.spawn(), Name, { value: 'created-by-init' });
    const before = world.snapshot();
    const hash = world.hash();
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      entities: [
        { target: { name: 'root/child~1part' }, visual: { kind: 'primitive', shape: 'box' } },
      ],
      hud: { playerName: 'created-by-init', winEvent: 'won', loseEvents: ['lost'] },
    };
    expect(validatePresentationWorld(manifest, world).ok).toBe(true);
    expect(world.snapshot()).toEqual(before);
    expect(world.hash()).toBe(hash);
  });

  it('reports every unresolved name with its exact manifest location', () => {
    const world = createWorld({ seed: 0 });
    world.add(world.spawn(), Name, { value: 'actual-name' });
    const result = validatePresentationWorld(
      {
        aegis: 'presentation/1',
        entities: [{ target: { name: 'typo' }, visual: { kind: 'primitive', shape: 'box' } }],
        objects: [
          {
            id: 'attachment',
            anchor: { entity: 'absent' },
            visual: { kind: 'primitive', shape: 'box' },
          },
        ],
        effects: [{ event: 'hit', kind: 'pulse', target: { entity: 'missing' }, durationTicks: 6 }],
        hud: { playerName: 'nobody', winEvent: 'won', loseEvents: [] },
      },
      world,
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.location?.path)).toEqual([
      'entities[0].target.name',
      'objects[0].anchor.entity',
      'effects[0].target.entity',
      'hud.playerName',
    ]);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'AEG-RENDER-0002')).toBe(
      true,
    );
  });

  it('allows role defaults in an empty world but never claims an absent named target exists', () => {
    const world = createWorld({ seed: 0 });
    expect(validatePresentationWorld({ aegis: 'presentation/1' }, world).ok).toBe(true);
    expect(
      validatePresentationWorld(
        {
          aegis: 'presentation/1',
          entities: [{ target: { name: 'absent' }, visual: { kind: 'primitive', shape: 'box' } }],
        },
        world,
      ).ok,
    ).toBe(false);
  });
});
