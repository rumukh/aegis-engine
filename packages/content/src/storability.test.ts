/**
 * HIGH 1 — the contract `aegis validate` sells: **validate-clean implies instantiate-succeeds.**
 *
 * `parseScene` and `validateScene` both returned `ok: true` for documents that then killed
 * `instantiateScene` with `AEG-CORE-0001`. For an agent-first engine that is the worst shape a
 * defect can take: the tool whose entire job is to catch the problem before the run reports that
 * the problem is not there, so the agent proceeds and the failure surfaces somewhere else
 * entirely.
 *
 * Four holes produced it, and all four are shapeless-by-design places the schema pass could not
 * look:
 *
 * 1. `JSON.parse('1e999')` is `Infinity` — valid JSON, invalid state, and `typeof` says `number`
 * 2. a scene's `resources` block was never inspected at all
 * 3. a free-form `optional: { data: 'object' }` field has no shape to check against
 * 4. array elements have no element schema to check against
 *
 * The two tests that matter are the **two original repros** (so a regression re-opens a hole we
 * have actually seen) and a **property check over a hostile corpus** (so a fifth hole of the same
 * kind is caught without anyone having thought of it first). Both are useless without the
 * negative control below them, which proves the corpus can produce a red.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, Name, Transform } from '@aegis/core';
import { createRegistry } from './registry.js';
import { instantiateScene, parseScene, validateScene } from './load.js';
import { ContentCode } from './diagnostics.js';
import { Dead, Health, Trigger, Triggered } from './components/gameplay.js';
import type { SceneFile } from './scene.js';

const registry = createRegistry(Transform, Name, Health, Trigger, Triggered, Dead);

/** `{"a":{"a":…}}` as JSON text, nested `depth` levels. */
function deepJson(depth: number): string {
  let v = '1';
  for (let i = 0; i < depth; i++) v = `{"a":${v}}`;
  return v;
}

function scene(body: string): string {
  return `{"aegis":"scene/1","name":"probe","mode":"platformer",${body}}`;
}

/**
 * What the loader really does with `text`: `'loaded'` or `'threw'`. Validation is switched off
 * so the loader is exercised directly — otherwise this would just be measuring the validator
 * against itself, which is the tautology the whole file exists to avoid.
 */
function loaderOutcome(text: string): 'loaded' | 'threw' {
  const parsed = parseScene(text, 'probe.scene.json');
  if (!parsed.ok || parsed.value === undefined) return 'threw'; // rejected before instantiation
  try {
    instantiateScene(createWorld({ seed: 1 }), parsed.value, { registry, validate: false });
    return 'loaded';
  } catch {
    return 'threw';
  }
}

/** What `parseScene` + `validateScene` say: `'clean'` or `'rejected'`. */
function validatorOutcome(text: string): 'clean' | 'rejected' {
  const parsed = parseScene(text, 'probe.scene.json');
  if (!parsed.ok || parsed.value === undefined) return 'rejected';
  return validateScene(parsed.value, { registry, file: 'probe.scene.json' }).ok
    ? 'clean'
    : 'rejected';
}

/**
 * The corpus. `loads` is written by hand from what the *document* means, never read back from
 * either implementation — an expectation captured from the thing under test can never fail.
 */
const CORPUS: readonly { label: string; text: string; loads: boolean }[] = [
  // --- documents that must load -------------------------------------------------------------
  { label: 'an empty scene', text: scene('"entities":[]'), loads: true },
  {
    label: 'ordinary component data',
    text: scene('"entities":[{"id":"a","components":{"Health":{"current":3,"max":3}}}]'),
    loads: true,
  },
  {
    label: 'a free-form Trigger.data holding only finite values',
    text: scene('"entities":[{"id":"a","components":{"Trigger":{"data":{"switch":"vault","n":2}}}}]'), // prettier-ignore
    loads: true,
  },
  {
    label: 'a free-form Trigger.data holding an array of finite values',
    text: scene('"entities":[{"id":"a","components":{"Trigger":{"data":{"xs":[1,2,3]}}}}]'),
    loads: true,
  },
  {
    label: 'a resource holding an ordinary object',
    text: scene('"resources":{"custom.cfg":{"gravity":60}},"entities":[]'),
    loads: true,
  },
  {
    label: 'a resource holding null',
    text: scene('"resources":{"custom.cfg":null},"entities":[]'),
    loads: true,
  },
  { label: 'tags', text: scene('"entities":[{"id":"a","tags":["Player"]}]'), loads: true },
  {
    label: 'a nested child entity',
    text: scene('"entities":[{"id":"a","children":[{"id":"b","components":{"Health":{}}}]}]'),
    loads: true,
  },
  {
    label: 'legal nesting inside a free-form field',
    text: scene(`"entities":[{"id":"a","components":{"Trigger":{"data":${deepJson(20)}}}}]`),
    loads: true,
  },

  // --- documents that must not ---------------------------------------------------------------
  {
    // Repro 1.
    label: 'REPRO: 1e999 in a free-form Trigger.data field',
    text: scene('"entities":[{"id":"a","components":{"Trigger":{"data":{"v":1e999}}}}]'),
    loads: false,
  },
  {
    // Repro 2.
    label: 'REPRO: 1e999 in a scene resource',
    text: scene('"resources":{"custom.cfg":{"gravity":1e999}},"entities":[]'),
    loads: false,
  },
  {
    label: '-1e999 as an array element inside a free-form field',
    text: scene('"entities":[{"id":"a","components":{"Trigger":{"data":{"xs":[1,-1e999]}}}}]'),
    loads: false,
  },
  {
    label: '1e999 in a typed number field',
    text: scene('"entities":[{"id":"a","components":{"Transform":{"position":{"x":1e999,"y":0,"z":0}}}}]'), // prettier-ignore
    loads: false,
  },
  {
    label: '1e999 nested two objects into a free-form field',
    text: scene('"entities":[{"id":"a","components":{"Trigger":{"data":{"a":{"b":1e999}}}}}]'),
    loads: false,
  },
  {
    label: 'runaway nesting in a free-form field',
    text: scene(`"entities":[{"id":"a","components":{"Trigger":{"data":${deepJson(200)}}}}]`),
    loads: false,
  },
  {
    label: 'runaway nesting in a resource',
    text: scene(`"resources":{"custom.cfg":${deepJson(200)}},"entities":[]`),
    loads: false,
  },
  {
    label: '1e999 on a child entity',
    text: scene('"entities":[{"id":"a","children":[{"id":"b","components":{"Trigger":{"data":{"v":1e999}}}}]}]'), // prettier-ignore
    loads: false,
  },
];

describe('validate-clean implies instantiate-succeeds', () => {
  it('holds for every document in the hostile corpus', () => {
    const disagreements = CORPUS.filter(
      ({ text }) =>
        (validatorOutcome(text) === 'clean' ? 'loaded' : 'threw') !== loaderOutcome(text),
    ).map(({ label, text }) => `${label} — validator says ${validatorOutcome(text)}`);
    expect(disagreements).toEqual([]);
  });

  it('the corpus is the instrument: every hand-written expectation matches the loader', () => {
    // Negative control. If the corpus were all-loadable (or all-fatal), the property above
    // would pass against a validator that answered "clean" (or "rejected") unconditionally.
    const loadable = CORPUS.filter((c) => c.loads);
    expect(loadable.length).toBeGreaterThan(5);
    expect(CORPUS.length - loadable.length).toBeGreaterThan(5);
    for (const { label, text, loads } of CORPUS) {
      expect(`${label}: ${loaderOutcome(text)}`).toBe(`${label}: ${loads ? 'loaded' : 'threw'}`);
    }
  });

  it('an unconditional validator would fail the property — the control for the control', () => {
    // Proves the property test can go red, without waiting for a regression to prove it.
    const alwaysClean = (): 'clean' => 'clean';
    const wrong = CORPUS.filter(
      ({ text }) => (alwaysClean() === 'clean' ? 'loaded' : 'threw') !== loaderOutcome(text),
    );
    expect(wrong.length).toBeGreaterThan(0);
  });
});

describe('the two original repros are now diagnostics', () => {
  it('repro 1: a free-form component field holding 1e999', () => {
    const text = scene('"entities":[{"id":"a","components":{"Trigger":{"data":{"v":1e999}}}}]');
    const parsed = parseScene(text, 'probe.scene.json');
    expect(parsed.ok).toBe(true);
    const result = validateScene((parsed as { value: SceneFile }).value, {
      registry,
      file: 'probe.scene.json',
    });
    expect(result.ok).toBe(false);
    const d = result.diagnostics.find((x) => x.code === ContentCode.UnserialisableValue);
    expect(d?.location?.path).toBe('entities[0].components.Trigger.data.v');
    expect(d?.location?.file).toBe('probe.scene.json');
    expect(d?.data?.['reason']).toBe('non-finite');
    expect(d?.message).toContain('Infinity');
  });

  it('repro 2: a scene resource holding 1e999', () => {
    const text = scene('"resources":{"custom.cfg":{"gravity":1e999}},"entities":[]');
    const parsed = parseScene(text, 'probe.scene.json');
    expect(parsed.ok).toBe(true);
    const result = validateScene((parsed as { value: SceneFile }).value, {
      registry,
      file: 'probe.scene.json',
    });
    expect(result.ok).toBe(false);
    const d = result.diagnostics.find((x) => x.code === ContentCode.UnserialisableValue);
    // Resource ids are dotted by convention, so the bracket form is the only unambiguous path.
    expect(d?.location?.path).toBe('resources["custom.cfg"].gravity');
    expect(d?.data?.['reason']).toBe('non-finite');
  });

  it('reports every offender in one pass, not one per run', () => {
    const text = scene(
      '"resources":{"r":{"a":1e999}},"entities":[{"id":"a","components":{"Trigger":{"data":{"b":-1e999,"c":[1e999]}}}}]',
    );
    const parsed = parseScene(text, 'probe.scene.json');
    const result = validateScene((parsed as { value: SceneFile }).value, { registry });
    const paths = result.diagnostics
      .filter((d) => d.code === ContentCode.UnserialisableValue)
      .map((d) => d.location?.path);
    expect(paths).toEqual([
      'resources["r"].a',
      'entities[0].components.Trigger.data.b',
      'entities[0].components.Trigger.data.c[0]',
    ]);
  });

  it('a typed number field is reported once, not twice', () => {
    // The shape pass already calls `1e999` a type mismatch ("must be a finite number"), so the
    // storability pass must not pile a second diagnostic onto the same path.
    const text = scene(
      '"entities":[{"id":"a","components":{"Transform":{"position":{"x":1e999,"y":0,"z":0}}}}]',
    );
    const parsed = parseScene(text, 'probe.scene.json');
    const result = validateScene((parsed as { value: SceneFile }).value, { registry });
    const atPath = result.diagnostics.filter(
      (d) => d.location?.path === 'entities[0].components.Transform.position.x',
    );
    expect(atPath.map((d) => d.code)).toEqual([ContentCode.TypeMismatch]);
  });
});
