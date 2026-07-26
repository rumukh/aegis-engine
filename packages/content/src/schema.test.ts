import { describe, it, expect } from 'vitest';
import { createWorld, defineComponent, defineTag, Name, Transform } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import { createRegistry } from './registry.js';
import { instantiateScene, validateScene } from './load.js';
import { ContentCode } from './diagnostics.js';
import {
  componentFields,
  componentSchema,
  describeComponent,
  suggestName,
  validateComponentData,
} from './schema.js';
import { Health, Trigger } from './components/gameplay.js';
import { Light, Model, Sprite } from './components/visual.js';
import type { SceneFile } from './scene.js';

function registry() {
  return createRegistry(Transform, Name, Sprite, Model, Light, Health, Trigger);
}

/** Validate one entity's components in a minimal scene; returns the diagnostics. */
function validateEntity(
  components: Record<string, Record<string, unknown>>,
): readonly Diagnostic[] {
  const scene: SceneFile = {
    aegis: 'scene/1',
    name: 'S',
    mode: 'platformer',
    entities: [{ id: 'e', components }],
  };
  return validateScene(scene, { registry: registry(), file: 'level.scene.json' }).diagnostics;
}

function of(diags: readonly Diagnostic[], code: string): readonly Diagnostic[] {
  return diags.filter((d) => d.code === code);
}

describe('suggestName (the did-you-mean engine)', () => {
  it('catches a dropped letter, an extra letter and a transposition', () => {
    expect(suggestName('curent', ['current', 'max'])).toBe('current');
    expect(suggestName('maxx', ['current', 'max'])).toBe('max');
    expect(suggestName('nmae', ['name', 'mode'])).toBe('name');
  });

  it('catches a case-only difference before anything else', () => {
    expect(suggestName('HALF', ['half', 'hall'])).toBe('half');
  });

  it('stays quiet when nothing is genuinely close', () => {
    expect(suggestName('hp', ['current', 'max'])).toBeUndefined();
    expect(suggestName('w', ['x', 'y', 'z'])).toBeUndefined(); // one-letter fields are all "close"
  });

  it('is deterministic: candidate order never changes the answer', () => {
    const a = suggestName('curent', ['max', 'current', 'cure']);
    const b = suggestName('curent', ['cure', 'current', 'max']);
    expect(a).toBe(b);
  });
});

describe('componentFields / describeComponent', () => {
  it('lists the defaults plus any declared optional fields, sorted', () => {
    expect(componentFields(Health)).toEqual(['current', 'max']);
    expect(componentFields(Trigger)).toEqual(['data', 'half', 'kind', 'once', 'radius', 'shape']);
  });

  it('reports no fields for a marker component', () => {
    expect(componentFields(defineTag('Player'))).toEqual([]);
  });

  it('keeps declarations per component identity, not per id', () => {
    const a = defineComponent<{ v: number }>({ id: 'Same', defaults: () => ({ v: 0 }) });
    const b = defineComponent<{ v: number }>({ id: 'Same', defaults: () => ({ v: 0 }) });
    describeComponent(a, { optional: { extra: 'string' } });
    expect(componentSchema(a)?.optional).toEqual({ extra: 'string' });
    expect(componentSchema(b)).toBeUndefined();
  });
});

describe('the four silent-failure demonstrations', () => {
  // Each of these loaded with `ok: true` and zero diagnostics before this validation existed,
  // producing a level that runs without error and cannot be completed.

  it('DEMO 1 — a partial nested object (Transform.position missing y/z) is rejected', () => {
    const diags = validateEntity({ Transform: { position: { x: 3 } } });
    const d = of(diags, ContentCode.IncompleteNestedObject)[0];
    expect(d).toBeDefined();
    expect(d?.location).toEqual({
      file: 'level.scene.json',
      path: 'entities[0].components.Transform.position',
    });
    expect(d?.data?.['missing']).toEqual(['y', 'z']);
    // The fix keeps the authored x and fills the rest from the default, ready to paste back.
    expect(d?.data?.['complete']).toEqual({ x: 3, y: 0, z: 0 });
    expect(d?.fix).toContain('{"x":3,"y":0,"z":0}');
  });

  it("DEMO 2 — three typo'd Health fields each get their own diagnostic", () => {
    const diags = validateEntity({ Health: { curent: 50, maxx: 50, hp: 'fifty' } });
    const unknown = of(diags, ContentCode.UnknownField);
    expect(unknown).toHaveLength(3);
    expect(unknown.map((d) => d.data?.['field'])).toEqual(['curent', 'maxx', 'hp']);
    expect(unknown.map((d) => d.data?.['suggestion'])).toEqual(['current', 'max', undefined]);
    expect(unknown[0]?.location?.path).toBe('entities[0].components.Health.curent');
    expect(unknown[0]?.fix).toBe('Rename "curent" to "current".');
    expect(unknown[2]?.message).toContain('has no field "hp". Unknown fields are stored');
    // No near-miss for "hp", so the fix must still be actionable: list the real fields.
    expect(unknown[2]?.fix).toBe('Remove "hp", or replace it with one of: current, max.');
  });

  it('DEMO 3 — a string and a null where numbers belong are both rejected', () => {
    const diags = validateEntity({ Health: { current: 'lots', max: null } });
    const mismatches = of(diags, ContentCode.TypeMismatch);
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0]?.message).toContain('must be a finite number, but "lots" (string)');
    expect(mismatches[0]?.fix).toContain('e.g. 1 (the default)');
    expect(mismatches[1]?.message).toContain('must be a finite number, but null was authored');
    expect(mismatches[1]?.data?.['received']).toBe('null');
  });

  it('DEMO 4 — a Trigger volume with a partial half-extent can never fire, and is rejected', () => {
    const diags = validateEntity({ Trigger: { kind: 'goal', half: { x: 2 } } });
    const d = of(diags, ContentCode.IncompleteNestedObject)[0];
    expect(d).toBeDefined();
    expect(d?.location?.path).toBe('entities[0].components.Trigger.half');
    expect(d?.data?.['missing']).toEqual(['y', 'z']);
    expect(d?.fix).toContain('{"x":2,"y":0.5,"z":0.5}');
  });

  it('every demonstration fails validation and spawns nothing', () => {
    const cases: Record<string, Record<string, unknown>>[] = [
      { Transform: { position: { x: 3 } } },
      { Health: { curent: 50, maxx: 50, hp: 'fifty' } },
      { Health: { current: 'lots', max: null } },
      { Trigger: { kind: 'goal', half: { x: 2 } } },
    ];
    for (const components of cases) {
      const scene: SceneFile = {
        aegis: 'scene/1',
        name: 'S',
        mode: 'platformer',
        entities: [{ id: 'e', components }],
      };
      const world = createWorld({ seed: 1 });
      const result = instantiateScene(world, scene, { registry: registry() });
      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
      expect(world.entityCount).toBe(0);
    }
  });
});

describe('validateComponentData', () => {
  const where = { path: 'c', file: 'f.json' };

  it('accepts a partial at the top level — those merge over the defaults', () => {
    expect(validateComponentData(Health, { current: 3 }, where)).toEqual([]);
    expect(validateComponentData(Health, {}, where)).toEqual([]);
  });

  it('accepts a complete nested object', () => {
    expect(validateComponentData(Transform, { position: { x: 1, y: 2, z: 3 } }, where)).toEqual([]);
  });

  it('rejects NaN and Infinity, which JSON cannot express but a builder can', () => {
    expect(
      of(validateComponentData(Health, { current: NaN }, where), ContentCode.TypeMismatch),
    ).toHaveLength(1);
    expect(
      of(validateComponentData(Health, { current: Infinity }, where), ContentCode.TypeMismatch),
    ).toHaveLength(1);
  });

  it('checks types by JSON kind: boolean, string, array and object', () => {
    const diags = validateComponentData(Trigger, { once: 'yes', kind: 7, half: [1, 2, 3] }, where);
    expect(of(diags, ContentCode.TypeMismatch)).toHaveLength(3);
    expect(diags[0]?.message).toContain('field "once" must be a boolean');
    expect(diags[1]?.message).toContain('field "kind" must be a string');
    expect(diags[2]?.message).toContain('field "half" must be an object');
  });

  it("reports an unknown key inside a nested object against that object's keys", () => {
    const diags = validateComponentData(Transform, { position: { x: 1, y: 2, z: 3, w: 4 } }, where);
    const d = of(diags, ContentCode.UnknownField)[0];
    expect(d?.message).toContain('field "position" has no key "w"');
    expect(d?.location?.path).toBe('c.position.w');
    expect(d?.data?.['known']).toEqual(['x', 'y', 'z']);
  });

  it('reports a mistyped value inside a nested object with the full field path', () => {
    const diags = validateComponentData(Transform, { position: { x: '1', y: 2, z: 3 } }, where);
    expect(diags[0]?.code).toBe(ContentCode.TypeMismatch);
    expect(diags[0]?.data?.['field']).toBe('position.x');
    expect(diags[0]?.location?.path).toBe('c.position.x');
  });

  it('tells an author that a marker component has no fields at all', () => {
    const Player = defineTag('Player');
    const d = validateComponentData(Player, { level: 3 }, where)[0];
    expect(d?.code).toBe(ContentCode.UnknownField);
    expect(d?.fix).toContain('(none: it is a marker component)');
  });

  it('rejects component data that is not an object', () => {
    const d = validateComponentData(Health, 42, where)[0];
    expect(d?.code).toBe(ContentCode.InvalidComponentData);
    expect(d?.data?.['received']).toBe('number');
  });

  it('accepts a declared optional field that the defaults cannot show', () => {
    // games/fps authors Trigger.data; TriggerData declares it optional, so defaults() omits it.
    expect(validateComponentData(Trigger, { data: { cause: 'coolant' } }, where)).toEqual([]);
    expect(validateComponentData(Sprite, { frame: 'idle_0', tint: '#ff0000' }, where)).toEqual([]);
    expect(validateComponentData(Model, { material: 'steel', castShadow: true }, where)).toEqual(
      [],
    );
  });

  it('still type-checks a declared optional field', () => {
    const d = validateComponentData(Trigger, { data: 'coolant' }, where)[0];
    expect(d?.code).toBe(ContentCode.TypeMismatch);
    expect(d?.data?.['field']).toBe('data');
  });

  it('rejects a value outside a declared closed set, with a suggestion', () => {
    const d = validateComponentData(Trigger, { shape: 'spere' }, where)[0];
    expect(d?.code).toBe(ContentCode.InvalidFieldValue);
    expect(d?.message).toContain('did you mean "sphere"?');
    expect(d?.data?.['allowed']).toEqual(['box', 'sphere']);
    expect(validateComponentData(Light, { kind: 'ambient' }, where)).toEqual([]);
    expect(validateComponentData(Light, { kind: 'spotlight' }, where)[0]?.code).toBe(
      ContentCode.InvalidFieldValue,
    );
  });

  it('leaves an open string field alone — TriggerKind is deliberately extensible', () => {
    expect(validateComponentData(Trigger, { kind: 'teleporter' }, where)).toEqual([]);
  });

  it('does not inspect the contents of a free-form optional object', () => {
    expect(
      validateComponentData(Trigger, { data: { anything: [1, { deep: true }] } }, where),
    ).toEqual([]);
  });
});

describe('validation runs on the whole document', () => {
  it('checks components on nested children too', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [
        { id: 'parent', children: [{ id: 'child', components: { Health: { curent: 2 } } }] },
      ],
    };
    const r = validateScene(scene, { registry: registry() });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.location?.path).toBe(
      'entities[0].children[0].components.Health.curent',
    );
  });

  it('suggests a component id, not just a list of them', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'e', components: { Helth: { current: 2 } } }],
    };
    const d = validateScene(scene, { registry: registry() }).diagnostics[0];
    expect(d?.code).toBe(ContentCode.UnknownComponent);
    expect(d?.message).toContain('unknown component "Helth" - did you mean "Health"?');
    expect(d?.data?.['suggestion']).toBe('Health');
  });

  it('leaves a valid scene clean', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [
        {
          id: 'goal',
          components: {
            Transform: { position: { x: 1, y: 2, z: 0 } },
            Trigger: { kind: 'goal', shape: 'box', half: { x: 1, y: 1, z: 1 }, once: true },
            Health: { current: 5, max: 5 },
          },
        },
      ],
    };
    expect(validateScene(scene, { registry: registry() })).toEqual({
      ok: true,
      value: scene,
      diagnostics: [],
    });
  });
});
