import { describe, it, expect } from 'vitest';
import { createWorld, defineComponent, defineTag, Name, Transform } from '@aegis/core';
import type { World } from '@aegis/core';
import { createRegistry } from './registry.js';
import { createSceneBuilder } from './builder.js';
import { parseScene, parsePrefab, parseTilemap, validateScene, instantiateScene } from './load.js';
import type { PrefabResolver } from './load.js';
import { ContentCode } from './diagnostics.js';
import { Sprite } from './components/visual.js';
import type { PrefabFile, SceneFile } from './scene.js';

const Player = defineTag('Player');
interface Vel {
  dx: number;
  dy: number;
}
const Velocity = defineComponent<Vel>({ id: 'Velocity', defaults: () => ({ dx: 0, dy: 0 }) });

function registry() {
  return createRegistry(Transform, Name, Sprite, Player, Velocity);
}

describe('component registry', () => {
  it('registers, resolves and lists ids sorted', () => {
    const r = registry();
    expect(r.has('Transform')).toBe(true);
    expect(r.get('Sprite')).toBe(Sprite);
    expect(r.get('Nope')).toBeUndefined();
    expect(r.ids()).toEqual([...r.ids()].sort());
  });

  it('re-registering the same type is idempotent, a conflicting id throws', () => {
    const r = createRegistry();
    r.register(Transform);
    r.register(Transform); // ok
    const fake = defineComponent({ id: 'Transform', defaults: () => ({}) });
    expect(() => r.register(fake)).toThrow();
  });
});

describe('scene builder', () => {
  it('emits a canonical scene/1 document', () => {
    const scene = createSceneBuilder('Level 1', 'platformer')
      .resource('Gravity', { y: -9.8 })
      .entity('hero', (e) => {
        e.with(Transform, { position: { x: 1, y: 2, z: 0 } })
          .with(Velocity, { dx: 1 })
          .tag('Player');
      })
      .entity('slot', (e) => {
        e.fromPrefab('enemy').child('gun', (c) => c.with(Sprite, { texture: 'gun.png' }));
      })
      .build();

    expect(scene.aegis).toBe('scene/1');
    expect(scene.mode).toBe('platformer');
    expect(scene.resources).toEqual({ Gravity: { y: -9.8 } });
    expect(scene.entities).toHaveLength(2);
    expect(scene.entities[0]?.id).toBe('hero');
    expect(scene.entities[0]?.tags).toEqual(['Player']);
    expect(scene.entities[0]?.components?.['Velocity']).toEqual({ dx: 1, dy: 0 });
    expect(scene.entities[1]?.prefab).toBe('enemy');
    expect(scene.entities[1]?.children?.[0]?.id).toBe('gun');
  });

  it('a built scene validates and instantiates', () => {
    const scene = createSceneBuilder('S', 'platformer')
      .entity('hero', (e) => e.with(Transform).tag('Player'))
      .build();
    const w = createWorld({ seed: 1 });
    const result = instantiateScene(w, scene, { registry: registry() });
    expect(result.ok).toBe(true);
    expect(w.isAlive(result.entities['hero'] as never)).toBe(true);
  });
});

describe('parseScene', () => {
  it('parses a valid scene', () => {
    const text = JSON.stringify({
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'a', components: { Transform: {} } }],
    });
    const r = parseScene(text, 'a.scene.json');
    expect(r.ok).toBe(true);
    expect(r.value?.name).toBe('S');
  });

  it('reports invalid JSON with a stable code', () => {
    const r = parseScene('{ not json', 'bad.json');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe(ContentCode.InvalidJson);
    expect(r.diagnostics[0]?.location?.file).toBe('bad.json');
  });

  it('reports an unknown format', () => {
    const r = parseScene(
      JSON.stringify({ aegis: 'scene/2', name: 'x', mode: 'fps', entities: [] }),
    );
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.code).toBe(ContentCode.UnknownFormat);
  });

  it('reports missing/mistyped fields with a path', () => {
    const r = parseScene(JSON.stringify({ aegis: 'scene/1', mode: 123, entities: [{}] }));
    expect(r.ok).toBe(false);
    const codes = r.diagnostics.map((d) => d.code);
    expect(codes).toContain(ContentCode.MissingField); // name
    expect(codes).toContain(ContentCode.TypeMismatch); // mode not a string
  });
});

describe('validateScene', () => {
  const opts = () => ({ registry: registry() });

  it('flags an unknown component with candidates', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'a', components: { Bogus: { x: 1 } } }],
    };
    const r = validateScene(scene, opts());
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === ContentCode.UnknownComponent);
    expect(d).toBeDefined();
    expect(d?.data?.['component']).toBe('Bogus');
  });

  it('flags duplicate ids (including nested children)', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'dup', children: [{ id: 'dup' }] }],
    };
    const r = validateScene(scene, opts());
    expect(r.diagnostics.some((d) => d.code === ContentCode.DuplicateId)).toBe(true);
  });

  it('flags an unknown mode', () => {
    const scene = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'roguelike',
      entities: [],
    } as unknown as SceneFile;
    const r = validateScene(scene, opts());
    expect(r.diagnostics.some((d) => d.code === ContentCode.UnknownMode)).toBe(true);
  });

  it('flags an unresolved prefab', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'a', prefab: 'missing' }],
    };
    const r = validateScene(scene, opts());
    expect(r.diagnostics.some((d) => d.code === ContentCode.UnknownPrefab)).toBe(true);
  });
});

describe('parsePrefab', () => {
  it('parses a prefab', () => {
    const r = parsePrefab(
      JSON.stringify({ aegis: 'prefab/1', name: 'enemy', components: { Transform: {} } }),
    );
    expect(r.ok).toBe(true);
    expect(r.value?.name).toBe('enemy');
  });
});

describe('parseTilemap (ASCII rows)', () => {
  const good = {
    aegis: 'tilemap/1',
    name: 'level',
    width: 4,
    height: 2,
    tileSize: 1,
    legend: { '#': { solid: true }, '.': {} },
    layers: [{ name: 'collision', data: ['#..#', '#..#'] }],
  };

  it('parses a well-formed tilemap', () => {
    const r = parseTilemap(JSON.stringify(good));
    expect(r.ok).toBe(true);
    expect(r.value?.width).toBe(4);
  });

  it('flags a row whose length disagrees with width', () => {
    const bad = { ...good, layers: [{ name: 'c', data: ['#..#', '#.#'] }] };
    const r = parseTilemap(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === ContentCode.TilemapShapeMismatch)).toBe(true);
  });

  it('flags the wrong number of rows', () => {
    const bad = { ...good, layers: [{ name: 'c', data: ['#..#'] }] };
    const r = parseTilemap(JSON.stringify(bad));
    expect(r.diagnostics.some((d) => d.code === ContentCode.TilemapShapeMismatch)).toBe(true);
  });

  it('flags an unknown tile key with its location', () => {
    const bad = { ...good, layers: [{ name: 'c', data: ['#Z.#', '#..#'] }] };
    const r = parseTilemap(JSON.stringify(bad));
    const d = r.diagnostics.find((x) => x.code === ContentCode.UnknownTile);
    expect(d).toBeDefined();
    expect(d?.data?.['key']).toBe('Z');
    expect(d?.location?.column).toBe(2);
  });
});

describe('instantiateScene', () => {
  const prefabs: PrefabResolver = {
    resolve(name) {
      if (name === 'enemy') {
        return {
          aegis: 'prefab/1',
          name: 'enemy',
          tags: ['Player'],
          components: { Velocity: { dx: 5, dy: 0 } },
        } satisfies PrefabFile;
      }
      return undefined;
    },
  };

  function build(scene: SceneFile, world: World) {
    return instantiateScene(world, scene, { registry: registry(), prefabs });
  }

  it('spawns entities, applies Name, merges component defaults, applies resources', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      resources: { Gravity: { y: -1 } },
      entities: [{ id: 'hero', tags: ['Player'], components: { Velocity: { dx: 2 } } }],
    };
    const w = createWorld({ seed: 1 });
    const result = build(scene, w);
    expect(result.ok).toBe(true);
    const hero = result.entities['hero'];
    expect(hero).toBeDefined();
    expect(w.get(hero as never, Name)).toEqual({ value: 'hero' });
    expect(w.get(hero as never, Velocity)).toEqual({ dx: 2, dy: 0 }); // merged over defaults
    expect(w.has(hero as never, Player)).toBe(true);
  });

  it('resolves prefabs then overrides with the decl', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'e', prefab: 'enemy', components: { Velocity: { dx: 9 } } }],
    };
    const w = createWorld({ seed: 1 });
    const result = build(scene, w);
    const e = result.entities['e'] as never;
    expect(w.get(e, Velocity)).toEqual({ dx: 9, dy: 0 }); // decl overrides prefab dx:5
    expect(w.has(e, Player)).toBe(true); // tag inherited from prefab
  });

  it('resolves child transforms relative to the parent world position', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [
        {
          id: 'parent',
          components: { Transform: { position: { x: 10, y: 0, z: 0 } } },
          children: [
            { id: 'child', components: { Transform: { position: { x: 1, y: 0, z: 0 } } } },
          ],
        },
      ],
    };
    const w = createWorld({ seed: 1 });
    const result = build(scene, w);
    const child = result.entities['child'] as never;
    expect(w.get(child, Transform)?.position.x).toBe(11); // 10 + 1
  });

  it('does not instantiate when validation fails', () => {
    const scene: SceneFile = {
      aegis: 'scene/1',
      name: 'S',
      mode: 'platformer',
      entities: [{ id: 'a', components: { Ghost: {} } }],
    };
    const w = createWorld({ seed: 1 });
    const result = instantiateScene(w, scene, { registry: registry() });
    expect(result.ok).toBe(false);
    expect(w.entityCount).toBe(0);
  });
});
