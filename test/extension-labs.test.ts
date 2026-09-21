import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyBoundaryTransforms,
  createRuntimeHost,
  failure,
  requireValue,
  success,
} from '@aegis/runtime';
import type { RuntimeSnapshot } from '@aegis/runtime';
import {
  createKitchen,
  boundaryRules,
  kitchenAdapter,
  kitchenTrace,
  loadKitchenContent,
  runKitchenTrace,
} from '../poc/turn-kitchen-lab/model.js';
import {
  createStory,
  loadStoryContent,
  runStoryTrace,
  storyTrace,
} from '../poc/storybook-lab/model.js';
import { repositoryRoot } from '../scripts/sdk-tools.mjs';
import { createCommandController } from '../poc/lab-shared/commands.js';
import {
  enumerateCaseCombinations,
  generatedTemplate,
  generateReference,
  printReference,
  restoreGeneratedCase,
} from '../poc/storybook-lab/extras.js';

const kitchen = () =>
  loadKitchenContent(
    readFileSync(join(repositoryRoot, 'poc', 'turn-kitchen-lab', 'balance.json'), 'utf8'),
  );
const story = () =>
  loadStoryContent(
    readFileSync(join(repositoryRoot, 'poc', 'storybook-lab', 'content.json'), 'utf8'),
  );

describe('public reference composition roots', () => {
  it('rejects an originating narrative command even without a UI revision guard', async () => {
    const host = createStory(story());
    requireValue(
      await host.dispatch({ type: 'choice', choice: 'look', node: 'welcome', revision: 0 }),
    );
    const before = host.snapshot();
    expect(
      await host.dispatch({ type: 'choice', choice: 'talk', node: 'welcome', revision: 0 }),
    ).toMatchObject({ ok: false });
    expect(host.snapshot()).toEqual(before);
    await host.dispose();
  });

  it('invalidates captured commands across same-revision restore and resumes accepted work without redispatch', async () => {
    let failed = false;
    const host = createKitchen(kitchen(), async ({ snapshot }) => {
      if (snapshot.turn === 1 && !failed) {
        failed = true;
        return failure('storage', 'Injected failure.');
      }
      return success(undefined);
    });
    const errors: unknown[] = [];
    const controls = createCommandController(host, (error) => errors.push(error));
    await controls.capture()({ type: 'begin' });
    const stale = controls.capture();
    requireValue(
      await host.restore(host.snapshot(), { durableRevision: host.getStatus().revision }),
    );
    await expect(stale({ type: 'wait' })).rejects.toThrow('replaced session');
    await controls.capture()({ type: 'start', recipe: 'batch-b' });
    await controls.capture()({ type: 'start', recipe: 'batch-a' });
    await expect(controls.capture()({ type: 'wait' })).rejects.toThrow();
    await controls.retry();
    expect(host.getStatus()).toMatchObject({ turn: 2, pendingAction: null, checkpoint: 'idle' });
    expect(host.getView().state.events).toEqual([
      'notice:workshop',
      'ready:batch-a',
      'ready:batch-b',
      'arrival:visitor',
      'expiration:reader',
    ]);
    expect(errors).toEqual([]);
    controls.dispose();
    await host.dispose();
  });
  it('enumerates both finite generated combinations and preserves the resolved case on restore', async () => {
    const combinations = enumerateCaseCombinations(generatedTemplate());
    expect(combinations).toHaveLength(2);
    expect(combinations.map((entry) => entry.ok)).toEqual([true, true]);
    const original = generateReference('saved-fixture');
    expect(restoreGeneratedCase(JSON.parse(JSON.stringify(original)))).toEqual(original);
    const host = createStory(story());
    requireValue(await host.dispatch({ type: 'generate' }));
    const saved = host.snapshot();
    const resumed = createStory(story());
    requireValue(await resumed.restore(JSON.parse(JSON.stringify(saved))));
    expect(resumed.inspect().state.generated).toEqual(host.inspect().state.generated);
    for (const paper of ['A4', 'Letter'] as const) {
      const html = printReference(paper);
      expect(html.replace(/\s+/g, ' ')).toContain('Записка лежала на столе.');
      expect(html).toContain('Что известно?');
      expect(html).not.toContain('<script');
    }
    await host.dispose();
    await resumed.dispose();
  });
  it('completes three story primitives, cited notebook help and one cosmetic claim', async () => {
    const result = await runStoryTrace(story());
    expect(result.view.story.node).toBe('complete');
    expect(result.view.puzzles.map((puzzle) => puzzle.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(result.view.candidates).toBe(1);
    expect(result.view.marks).toEqual([
      { axis: 'place', value: 'table', mark: 'confirmed', source: 'evidence', clueIds: ['place'] },
      { axis: 'place', value: 'shelf', mark: 'excluded', source: 'evidence', clueIds: ['place'] },
    ]);
    expect(result.view.reward).toBe(true);
    const host = createStory(story());
    expect(host.getView().reward).toBe(false);
    expect(
      await host.dispatch({ type: 'choice', choice: 'finish', node: 'welcome', revision: 0 }),
    ).toMatchObject({ ok: false });
    for (const action of storyTrace) requireValue(await host.dispatch(action));
    requireValue(
      await host.dispatch({ type: 'choice', choice: 'back', node: 'complete', revision: 2 }),
    );
    requireValue(
      await host.dispatch({ type: 'choice', choice: 'finish', node: 'room', revision: 3 }),
    );
    expect(host.inspect().state.story.collected.reward).toEqual(['scarf']);
    expect(host.getStatus().turn).toBe(0);
    await host.dispose();
  });

  it('resumes committed scene, matching and ordering progress without replaying claims', async () => {
    for (const checkpoint of [2, 4, 7, 10]) {
      const source = createStory(story());
      for (const action of storyTrace.slice(0, checkpoint))
        requireValue(await source.dispatch(action));
      const saved: unknown = JSON.parse(JSON.stringify(source.snapshot()));
      const restored = createStory(story());
      requireValue(await restored.restore(saved));
      for (const action of storyTrace.slice(checkpoint)) {
        requireValue(await source.dispatch(action));
        requireValue(await restored.dispatch(action));
      }
      expect(restored.hash()).toBe(source.hash());
      expect(restored.getView().reward).toBe(true);
      await source.dispose();
      await restored.dispose();
    }
  });

  it('keeps handoff projections neutral and pause reasons independent', async () => {
    const host = createStory(story());
    requireValue(await host.dispatch({ type: 'confirm', player: 'first' }));
    expect(host.getView().family).toMatchObject({ phase: 'active', player: 'first' });
    requireValue(await host.dispatch({ type: 'handoff', player: 'second' }));
    const handoff = JSON.stringify(host.getView().family);
    expect(handoff).not.toContain('private.first');
    expect(handoff).not.toContain('private.second');
    host.pause('user');
    host.pause('visibility');
    host.pause('handoff');
    host.resume('visibility');
    expect(host.getStatus().pauseReasons).toContain('user');
    const before = host.hash();
    expect(await host.dispatch({ type: 'name', value: 'Ёжик' })).toMatchObject({ ok: false });
    expect(host.hash()).toBe(before);
    host.resume('user');
    host.resume('handoff');
    requireValue(await host.dispatch({ type: 'confirm', player: 'second' }));
    expect(JSON.stringify(host.getView().family)).toContain('private.second');
    expect(JSON.stringify(host.getView().family)).not.toContain('private.first');
    await host.dispose();
  });

  it('executes exact zero/one/two costs and stable same-turn collision order', async () => {
    const result = await runKitchenTrace(kitchen());
    expect(result.commits.map(({ turn }) => turn)).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3]);
    expect(result.view.state.events).toEqual([
      'notice:workshop',
      'ready:batch-a',
      'ready:batch-b',
      'arrival:visitor',
      'expiration:reader',
    ]);
    expect(result.view.state.produced).toBe(2);
    expect(result.view.state.terminal).toBe('shared');
    expect(result.view.state.reward).toBe(1);
    expect(result.view.state.storyTokens).toBe(0);
    expect(result.hash).toBe((await runKitchenTrace(kitchen())).hash);
  });

  it('rejects invalid moves without cost or lost items and idempotently keeps the ending', async () => {
    const host = createKitchen(kitchen());
    requireValue(await host.dispatch({ type: 'begin' }));
    const before = host.snapshot();
    expect(await host.dispatch({ type: 'move', from: 0, to: 1 })).toMatchObject({ ok: false });
    expect(host.snapshot()).toEqual(before);
    for (const action of kitchenTrace.slice(1)) requireValue(await host.dispatch(action));
    requireValue(await host.dispatch({ type: 'finish', share: false }));
    expect(host.getView().state.terminal).toBe('shared');
    expect(host.getView().state.reward).toBe(1);
    const saved = JSON.parse(JSON.stringify(host.snapshot()));
    requireValue(await host.restore(saved));
    expect(host.getView().state.storyTokens).toBe(0);
    await host.dispose();
  });

  it('durably resumes the intermediate turn without an extra action, cost, or readiness effect', async () => {
    let stopped = false;
    let intermediate: RuntimeSnapshot | undefined;
    const host = createKitchen(kitchen(), async ({ snapshot }) => {
      if (snapshot.turn === 1 && !stopped) {
        intermediate = snapshot;
        stopped = true;
        return failure('storage', 'Injected intermediate checkpoint failure.');
      }
      return success(undefined);
    });
    for (const action of kitchenTrace.slice(0, 6)) requireValue(await host.dispatch(action));
    expect(await host.dispatch({ type: 'wait' })).toMatchObject({ ok: false });
    expect(host.getStatus().checkpoint).toBe('failed');
    const pending = host.snapshot();
    expect(await host.dispatch({ type: 'listen', actor: 'maker' })).toMatchObject({ ok: false });
    expect(host.snapshot()).toEqual(pending);
    expect(intermediate?.pending?.completedTurns).toBe(1);
    expect(host.getView().state.events).toEqual(['notice:workshop']);
    requireValue(await host.retryCheckpoint());
    requireValue(await host.continuePending());
    const restored = createKitchen(kitchen());
    requireValue(await restored.restore(JSON.parse(JSON.stringify(intermediate))));
    expect(await restored.dispatch({ type: 'wait' })).toMatchObject({ ok: false });
    requireValue(await restored.continuePending());
    expect(restored.hash()).toBe(host.hash());
    expect(restored.getView().state.events).toHaveLength(5);
    await restored.dispose();
    await host.dispose();
  });

  it('preserves same-turn free mutations and reports corrupt/incompatible snapshots atomically', async () => {
    const snapshots: RuntimeSnapshot[] = [];
    const host = createKitchen(kitchen(), async ({ snapshot }) => {
      snapshots.push(snapshot);
      return success(undefined);
    });
    for (const action of kitchenTrace.slice(0, 4)) requireValue(await host.dispatch(action));
    expect(snapshots.map((snapshot) => snapshot.turn)).toEqual([0, 0, 0, 0]);
    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2, 3, 4]);
    const restored = createKitchen(kitchen());
    requireValue(await restored.restore(snapshots.at(-1)));
    expect(restored.getView().state).toMatchObject({ hints: 1, purchases: 1, credit: 1 });
    const before = restored.hash();
    expect(await restored.restore({ ...restored.snapshot(), format: 'future/99' })).toMatchObject({
      ok: false,
    });
    expect(restored.hash()).toBe(before);
    await host.dispose();
    await restored.dispose();
  });

  it('uses one read-consistent boundary and supports six/eight slots plus external budget edits', async () => {
    const content = kitchen();
    const host = createKitchen(content);
    const original = structuredClone(host.getView().state);
    const rules = boundaryRules(content.data);
    const forward = requireValue(applyBoundaryTransforms(original, rules));
    const reverse = requireValue(applyBoundaryTransforms(original, [...rules].reverse()));
    expect(forward).toEqual(reverse);
    expect(forward.slots.slice(0, 3).map((slot) => slot.age)).toEqual([1, 1, 1]);
    const changed = {
      ...content,
      revision: 'lab-long',
      data: { ...content.data, phaseBudget: 9, capacity: 8 },
    };
    requireValue(await host.activateContent(requireValue(host.stageContent(changed)), 'restart'));
    requireValue(await host.dispatch({ type: 'begin' }));
    expect(host.getView().state.slots).toHaveLength(8);
    expect(host.getView().remaining).toBe(9);
    const before = host.hash();
    expect(
      host.stageContent({ ...changed, data: { ...changed.data, jobDelay: -1 } }),
    ).toMatchObject({ ok: false });
    expect(host.hash()).toBe(before);
    const incompatible = createRuntimeHost({
      adapter: kitchenAdapter,
      content,
      seed: 'turn-kitchen-lab',
    });
    expect(await incompatible.restore(host.snapshot())).toMatchObject({ ok: false });
    await host.dispose();
    await incompatible.dispose();
  });
});
