import { describe, expect, it } from 'vitest';
import { createWorld, defineComponent, Name, Transform } from '@aegis/core';
import { ContentCode } from './diagnostics.js';
import { createSceneBuilder } from './builder.js';
import {
  createPrefabResolver,
  expandScene,
  instantiateScene,
  parsePrefab,
  validatePrefab,
  validateScene,
} from './load.js';
import { createRegistry } from './registry.js';
import type { EntityDecl, PrefabFile, SceneFile } from './scene.js';

const Velocity = defineComponent({
  id: 'Velocity',
  defaults: () => ({ dx: 0, dy: 0 }),
});
const registry = createRegistry(Name, Transform, Velocity);
const position = (x: number) => ({ Transform: { position: { x, y: 0, z: 0 } } });
const template: PrefabFile = {
  aegis: 'prefab/1',
  name: 'assembly',
  components: position(10),
  children: [{ id: 'child', components: position(1) }],
};

function scene(...entities: EntityDecl[]): SceneFile {
  return { aegis: 'scene/1', name: 'prefab-test', mode: 'platformer', entities };
}

function build(document: SceneFile, ...prefabs: PrefabFile[]) {
  const world = createWorld({ seed: 1 });
  const result = instantiateScene(world, document, {
    registry,
    prefabs: createPrefabResolver(...prefabs),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { world, ...result };
}

describe('prefab hierarchy expansion', () => {
  it('inherits children from the typed builder until a child list is explicitly authored', () => {
    const document = createSceneBuilder('builder-prefabs', 'platformer')
      .entity('inherited', (entity) => entity.fromPrefab('assembly'))
      .entity('replaced', (entity) => entity.fromPrefab('assembly').child('inline', () => {}))
      .build();
    expect(document.entities[0]?.children).toBeUndefined();
    expect(Object.keys(build(document, template).entities)).toEqual([
      'inherited',
      'inherited/child',
      'replaced',
      'inline',
    ]);
  });

  it('instantiates inherited children at translated positions for every instance', () => {
    const document = scene(
      { id: 'first', prefab: 'assembly' },
      { id: 'second', prefab: 'assembly', components: position(20) },
    );
    const before = JSON.stringify(template);
    const result = build(document, template);
    expect(Object.keys(result.entities)).toEqual([
      'first',
      'first/child',
      'second',
      'second/child',
    ]);
    expect(
      result.world
        .query({ has: [Transform] })
        .views()
        .map((v) => v.get(Transform).position.x),
    ).toEqual([10, 11, 20, 21]);
    expect(
      result.world
        .query({ has: [Name] })
        .views()
        .map((v) => v.get(Name).value),
    ).toEqual(['first', 'first/child', 'second', 'second/child']);
    result.world.getOrThrow(result.entities['first/child']!, Transform).position.x = 99;
    expect(result.world.getOrThrow(result.entities['second/child']!, Transform).position.x).toBe(
      21,
    );
    expect(JSON.stringify(template)).toBe(before);
  });

  it('replaces inherited children only when the instance explicitly supplies a list', () => {
    const result = build(
      scene(
        {
          id: 'replacement',
          prefab: 'assembly',
          children: [{ id: 'scene-child', components: position(3) }],
        },
        { id: 'empty', prefab: 'assembly', children: [] },
      ),
      template,
    );
    expect(Object.keys(result.entities)).toEqual(['replacement', 'scene-child', 'empty']);
    expect(result.world.getOrThrow(result.entities['scene-child']!, Transform).position.x).toBe(13);
  });

  it('preserves scene-authored child IDs when a nested scene entity itself instantiates a prefab', () => {
    const result = build(
      scene({
        id: 'scene-root',
        components: position(100),
        children: [{ id: 'inline', prefab: 'assembly' }],
      }),
      template,
    );
    expect(Object.keys(result.entities)).toEqual(['scene-root', 'inline', 'inline/child']);
    expect(result.world.getOrThrow(result.entities['inline/child']!, Transform).position.x).toBe(
      111,
    );
  });

  it('keeps component overrides shallow, unions tags, and lets resolved IDs own Name', () => {
    const prefab: PrefabFile = {
      ...template,
      tags: ['Inherited', 'Shared'],
      components: { ...position(10), Velocity: { dx: 1, dy: 5 } },
    };
    const result = build(
      scene({
        id: 'instance',
        prefab: 'assembly',
        tags: ['Shared', 'Added'],
        components: { ...position(30), Velocity: { dx: 9 }, Name: { value: 'instance' } },
      }),
      prefab,
    );
    const root = result.entities['instance']!;
    expect(result.world.getOrThrow(root, Velocity)).toEqual({ dx: 9, dy: 5 });
    expect(result.world.getOrThrow(root, Name).value).toBe('instance');
    expect(result.world.query({ has: ['Inherited', 'Shared', 'Added'] }).count()).toBe(1);
    expect(result.world.getOrThrow(result.entities['instance/child']!, Transform).position.x).toBe(
      31,
    );
  });

  it('expands nested prefab references and transform-less grouping nodes in stable preorder', () => {
    const limb: PrefabFile = {
      aegis: 'prefab/1',
      name: 'limb',
      components: position(2),
      children: [{ id: 'tip', components: position(3) }],
    };
    const rig: PrefabFile = {
      ...template,
      children: [
        { id: 'left', prefab: 'limb' },
        { id: 'group', children: [{ id: 'right', prefab: 'limb' }] },
      ],
    };
    const result = build(scene({ id: 'rig', prefab: 'assembly' }), rig, limb);
    expect(Object.keys(result.entities)).toEqual([
      'rig',
      'rig/left',
      'rig/left/tip',
      'rig/group',
      'rig/group/right',
      'rig/group/right/tip',
    ]);
    expect(result.world.getOrThrow(result.entities['rig/left/tip']!, Transform).position.x).toBe(
      15,
    );
    expect(
      result.world.getOrThrow(result.entities['rig/group/right/tip']!, Transform).position.x,
    ).toBe(15);
    expect(build(scene({ id: 'rig', prefab: 'assembly' }), rig, limb).world.hash()).toBe(
      result.world.hash(),
    );
  });

  it('escapes local slash/tilde segments and safely stores special object-key IDs', () => {
    const prefab: PrefabFile = {
      ...template,
      children: [
        { id: 'part/one', components: position(1) },
        { id: 'part~one', components: position(2) },
        { id: 'part', children: [{ id: 'one', components: position(3) }] },
      ],
    };
    const result = build(scene({ id: '__proto__', prefab: 'assembly' }), prefab);
    expect(Object.keys(result.entities)).toEqual([
      '__proto__',
      '__proto__/part~1one',
      '__proto__/part~0one',
      '__proto__/part',
      '__proto__/part/one',
    ]);
    expect(result.world.getOrThrow(result.entities['__proto__']!, Name).value).toBe('__proto__');
  });

  it('resolves each prefab once per instantiation, not separately for validation and spawning', () => {
    let resolutions = 0;
    const world = createWorld({ seed: 1 });
    const result = instantiateScene(
      world,
      scene({ id: 'first', prefab: 'assembly' }, { id: 'second', prefab: 'assembly' }),
      {
        registry,
        prefabs: {
          resolve() {
            resolutions++;
            return { ...template, components: position(resolutions * 10) };
          },
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(resolutions).toBe(1);
    expect(world.getOrThrow(result.entities['second/child']!, Transform).position.x).toBe(11);
  });

  it('exports an explicit, idempotently expandable tree with local transforms', () => {
    const document = scene({ id: 'root', prefab: 'assembly' });
    const expanded = expandScene(document, { registry, prefabs: createPrefabResolver(template) });
    expect(expanded.ok).toBe(true);
    if (expanded.value === undefined) throw new Error('expansion returned no scene');
    expect(expanded.value.entities[0]?.prefab).toBeUndefined();
    expect(expanded.value.entities[0]?.children?.[0]?.id).toBe('root/child');
    expect(expanded.value.entities[0]?.children?.[0]?.components?.['Transform']).toEqual({
      position: { x: 1, y: 0, z: 0 },
    });
    expect(expandScene(expanded.value, { registry }).value).toEqual(expanded.value);
    expect(build(expanded.value).world.snapshot()).toEqual(
      build(document, template).world.snapshot(),
    );
    expect(document.entities[0]?.prefab).toBe('assembly');
  });
});

describe('prefab hierarchy diagnostics', () => {
  it('rejects conflicting authored names before mutation and explains the identity migration', () => {
    for (const [document, prefab, path] of [
      [
        scene({ id: 'root', components: { Name: { value: 'label' } } }),
        template,
        'entities[0].components.Name.value',
      ],
      [
        scene({ id: 'root', prefab: 'assembly' }),
        { ...template, components: { ...position(10), Name: { value: 'label' } } },
        'prefabs["assembly"].components.Name.value',
      ],
      [
        scene({ id: 'root', prefab: 'assembly' }),
        { ...template, children: [{ id: 'child', components: { Name: { value: 'child' } } }] },
        'prefabs["assembly"].children[0].components.Name.value',
      ],
    ] as const) {
      const world = createWorld({ seed: 1 });
      const result = instantiateScene(world, document, {
        registry,
        prefabs: createPrefabResolver(prefab),
      });
      expect(result.ok).toBe(false);
      const problem = result.diagnostics.find((d) => d.code === ContentCode.EntityNameMismatch);
      expect(problem?.location?.path).toBe(path);
      expect(problem?.fix).toContain('Remove the conflicting Name component');
      expect(world.entityCount).toBe(0);
    }
    const explicit = build(scene({ id: 'root', components: { Name: { value: 'root' } } }));
    expect(explicit.world.getOrThrow(explicit.entities['root']!, Name).value).toBe('root');
  });

  it('checks inherited child component data once, with prefab provenance', () => {
    const invalid: PrefabFile = {
      ...template,
      children: [{ id: 'child', components: { Velocity: { dx: 'fast' } } }],
    };
    const result = validateScene(
      scene({ id: 'first', prefab: 'assembly' }, { id: 'second', prefab: 'assembly' }),
      { registry, prefabs: createPrefabResolver(invalid), file: 'level.scene.json' },
    );
    expect(result.ok).toBe(false);
    const errors = result.diagnostics.filter((d) => d.code === ContentCode.TypeMismatch);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.location?.file).toBeUndefined();
    expect(errors[0]?.location?.path).toBe(
      'prefabs["assembly"].children[0].components.Velocity.dx',
    );
    expect(errors[0]?.data?.['prefab']).toBe('assembly');
    expect(errors[0]?.data?.['instantiatedBy']).toBe('first');
  });

  it('rejects duplicate local IDs and collisions with globally authored IDs before any writes', () => {
    for (const [document, prefab] of [
      [
        scene({ id: 'root', prefab: 'assembly' }),
        { ...template, children: [{ id: 'dup' }, { id: 'dup' }] },
      ],
      [scene({ id: 'root', prefab: 'assembly' }, { id: 'root/child' }), template],
    ] as const) {
      const world = createWorld({ seed: 1 });
      world.spawn(Name({ value: 'keep' }));
      const before = world.snapshot();
      const result = instantiateScene(
        world,
        { ...document, resources: { changed: true } },
        {
          registry,
          prefabs: createPrefabResolver(prefab),
        },
      );
      expect(result.ok).toBe(false);
      expect(result.diagnostics.some((d) => d.code === ContentCode.DuplicateId)).toBe(true);
      expect(world.snapshot()).toEqual(before);
    }
    expect(
      validatePrefab({ ...template, children: [{ id: 'dup' }, { id: 'dup' }] }, { registry }).ok,
    ).toBe(false);
  });

  it('reports unresolved inherited references at their prefab source', () => {
    const invalid: PrefabFile = { ...template, children: [{ id: 'child', prefab: 'missing' }] };
    const result = validateScene(scene({ id: 'root', prefab: 'assembly' }), {
      registry,
      prefabs: createPrefabResolver(invalid),
      file: 'level.scene.json',
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: ContentCode.UnknownPrefab,
      location: { path: 'prefabs["assembly"].children[0].prefab' },
    });
    expect(result.diagnostics[0]?.location?.file).toBeUndefined();
  });

  it('rejects cyclic prefab expansion, including indirect cycles and validate:false', () => {
    const a: PrefabFile = { ...template, name: 'a', children: [{ id: 'b', prefab: 'b' }] };
    const b: PrefabFile = { ...template, name: 'b', children: [{ id: 'a', prefab: 'a' }] };
    const direct: PrefabFile = { ...template, name: 'a', children: [{ id: 'self', prefab: 'a' }] };
    for (const prefabs of [createPrefabResolver(a, b), createPrefabResolver(direct)]) {
      for (const validate of [true, false]) {
        const world = createWorld({ seed: 1 });
        const result = instantiateScene(world, scene({ id: 'root', prefab: 'a' }), {
          registry,
          prefabs,
          validate,
        });
        expect(result.ok).toBe(false);
        expect(result.diagnostics.some((d) => d.code === 'AEG-CONTENT-0018')).toBe(true);
        expect(result.diagnostics.map((d) => d.message).join('\n')).toMatch(/a.*a/);
        expect(world.entityCount).toBe(0);
      }
    }
    expect(
      validatePrefab(direct, { registry }).diagnostics.some((d) => d.code === 'AEG-CONTENT-0018'),
    ).toBe(true);
  });

  it('allows a recursive template reference when an explicit child-list override terminates it', () => {
    const finite: PrefabFile = {
      ...template,
      children: [{ id: 'leaf', prefab: 'assembly', children: [] }],
    };
    const result = build(scene({ id: 'root', prefab: 'assembly' }), finite);
    expect(Object.keys(result.entities)).toEqual(['root', 'root/leaf']);
    expect(result.world.getOrThrow(result.entities['root/leaf']!, Transform).position.x).toBe(20);
  });

  it('rejects malformed prefab children and tag/reference types at parse time', () => {
    for (const invalid of [
      { ...template, children: {} },
      { ...template, tags: [42] },
      { ...template, children: [{ id: 'child', prefab: 42 }] },
      { ...template, children: [{ id: 'dup' }, { id: 'dup' }] },
    ]) {
      expect(parsePrefab(JSON.stringify(invalid)).ok).toBe(false);
    }
  });

  it('reports cyclic in-memory entity trees without overflowing the stack', () => {
    const recursive: EntityDecl = { id: 'recursive' };
    recursive.children = [recursive];
    const result = validateScene(scene(recursive), { registry });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === ContentCode.UnserialisableValue)).toBe(true);
  });
});
