import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ContentCode, validateScene, validateValue } from '@aegis/content';
import type { SceneFile } from '@aegis/content';
import {
  createSceneContext,
  HarnessCode,
  parseInputScript,
  runScene,
  scriptFromCommands,
} from '@aegis/harness';
import type { ModePlugin } from '@aegis/harness';
import { validatePresentation } from '../packages/render-three/src/presentation/validate.js';
import { coyoteGapPlugin } from '../games/platformer/src/plugin.js';
import { sectorBreachPlugin } from '../games/fps/src/plugin.js';
import { serverVaultPlugin } from '../games/iso/src/server-vault.js';
import { nullMeridianPlugin } from '../games/horror/src/plugin.js';
import { platformer } from '../poc/platformer.mjs';
import { fps } from '../poc/fps.mjs';
import { iso } from '../poc/iso.mjs';
import { horror } from '../poc/horror.mjs';

it.each([
  { game: platformer, plugin: coyoteGapPlugin },
  { game: iso, plugin: serverVaultPlugin },
  { game: fps, plugin: sectorBreachPlugin },
  { game: horror, plugin: nullMeridianPlugin },
] as const)(
  'checks $game.id scene, route, presentation and emitted payloads against its composed plugin',
  async ({ game, plugin }) => {
    const scene = JSON.parse(readFileSync(game.scene, 'utf8')) as SceneFile;
    const input = readFileSync(game.script, 'utf8');
    const events = plugin.events!();
    expect(validateScene(scene, createSceneContext(plugin)).diagnostics).toEqual([]);
    expect(parseInputScript(input, plugin.inputs!()).ok).toBe(true);
    expect(validatePresentation(game.presentation.manifest, undefined, events).diagnostics).toEqual(
      [],
    );
    const result = await runScene(scene, {
      plugin,
      ticks: game.scriptTicks,
      input,
      strictInput: true,
      captureTickHashes: false,
    });
    expect(result.events.count(game.acceptance.winEvent)).toBe(1);
    for (const e of result.events.history()) {
      expect(Object.hasOwn(events, e.type), e.type).toBe(true);
      expect(validateValue(e.data, events[e.type]!, e.type)).toEqual([]);
    }
  },
);

const coyote = JSON.parse(readFileSync(platformer.scene, 'utf8')) as SceneFile;
it('rejects Jmup at the token before init; Jump actually jumps at tick 28 despite equal resting hashes', async () => {
  const init = vi.fn(coyoteGapPlugin.init!);
  const options = {
    plugin: { ...coyoteGapPlugin, init },
    ticks: 90,
    strictInput: true,
    inputFile: 'probe.input',
  };
  await expect(
    runScene(coyote, { ...options, input: '# probe\n  press   Jmup @28' }),
  ).rejects.toMatchObject({
    diagnostics: [
      {
        code: HarnessCode.UnknownAction,
        location: { file: 'probe.input', line: 2, column: 11 },
        data: { suggestion: 'Jump' },
      },
    ],
  });
  await expect(
    runScene(coyote, {
      ...options,
      input: scriptFromCommands([
        { kind: 'axis', axis: 'MvoeX', value: 1, span: { start: 0, end: 7 } },
      ]),
    }),
  ).rejects.toMatchObject({
    diagnostics: [
      {
        code: HarnessCode.UnknownAxis,
        location: { path: 'commands[0].axis' },
        data: { suggestion: 'MoveX' },
      },
    ],
  });
  expect(init).not.toHaveBeenCalled();
  const idle = await runScene(coyote, options);
  const jump = await runScene(coyote, { ...options, input: 'press Jump @28' });
  expect(jump.events.history()).toContainEqual(
    expect.objectContaining({ type: 'player.jumped', tick: 28 }),
  );
  expect(idle.events.count('player.jumped')).toBe(0);
  expect(jump.hash).toBe(idle.hash);
});

it('rejects malformed nested authored resource values before init with their exact fields', async () => {
  const init = vi.fn();
  const level = JSON.parse(readFileSync(fps.scene, 'utf8'));
  const tile = level.resources['fps.floorplan'].legend['#'];
  delete tile.ceil;
  tile.ceill = 4;
  tile.solid = 'true';
  const result = validateScene(
    level,
    createSceneContext(sectorBreachPlugin, { file: 'level.json' }),
  );
  const path = 'resources["fps.floorplan"].legend["#"]';
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: ContentCode.UnknownField,
        location: { file: 'level.json', path: `${path}.ceill` },
        data: { field: 'ceill', suggestion: 'ceil' },
      }),
      expect.objectContaining({
        code: ContentCode.MissingField,
        location: { file: 'level.json', path: `${path}.ceil` },
      }),
      expect.objectContaining({
        code: ContentCode.InvalidDeclaredValue,
        location: { file: 'level.json', path: `${path}.solid` },
      }),
    ]),
  );
  await expect(
    runScene(level, { plugin: { ...sectorBreachPlugin, init }, ticks: 0 }),
  ).rejects.toHaveProperty('diagnostics');
  expect(init).not.toHaveBeenCalled();
});

it('keeps undeclared, partially declared and explicitly empty vocabularies distinct', async () => {
  const legacy: ModePlugin = {
    mode: 'platformer',
    components: () => [],
    systems: coyoteGapPlugin.systems,
    view: coyoteGapPlugin.view,
    resources: () => ['legacy.id'],
  };
  const scene: SceneFile = {
    aegis: 'scene/1',
    name: 'legacy',
    mode: 'platformer',
    entities: [],
    resources: { 'legacy.id': { extra: true } },
  };
  const input = 'hold Open 0..1\nrelease Open @1\naxis Speed 1 0..1\nclick 0,0 @1\nlook 1 2 @0';
  await expect(
    runScene(scene, { plugin: legacy, ticks: 2, strictInput: true, input }),
  ).resolves.toHaveProperty('tick', 2);
  expect(parseInputScript(input, { actions: ['Open'] }).ok).toBe(true);
  expect(parseInputScript(input, { actions: [], axes: [] }).diagnostics.map((d) => d.code)).toEqual(
    [HarnessCode.UnknownAction, HarnessCode.UnknownAction, HarnessCode.UnknownAxis],
  );
});
