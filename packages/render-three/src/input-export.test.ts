import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './catalog.js';
import { collectModuleGraph, engineModules, moduleSpecifiers } from './static-site.js';

const repoRoot = findRepoRoot();
const specifier = '@aegis/render-three/input';

describe('the built public input entry point', () => {
  it('resolves as a package consumer and imports without browser globals', async () => {
    // A separate Node process avoids Vitest's source aliases and cached browser-global mocks.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          Reflect.deleteProperty(globalThis, 'navigator');
          Reflect.deleteProperty(globalThis, 'window');
          Reflect.deleteProperty(globalThis, 'document');
          const input = await import('${specifier}');
          const sampler = input.createGamepadInput({ bindings: { sticks: [], buttons: [] } });
          const sample = sampler.sample();
          sampler.dispose();
          const buffer = input.createInputBuffer();
          buffer.setSource('consumer', { held: ['Jump'], axes: { MoveX: 0.5 } });
          const live = input.createLiveInput();
          live.submit(buffer.take());
          const frame = live.frameFor(12);
          console.log(JSON.stringify({
            resolved: import.meta.resolve('${specifier}'),
            functions: ['createGamepadInput', 'createInputBuffer', 'createLiveInput',
              'createInputCollector'].map(name => typeof input[name]),
            modes: Object.keys(input.BINDINGS).sort(),
            globals: [typeof navigator, typeof window, typeof document],
            held: sample.held,
            frame: { tick: frame.tick, actions: frame.actions,
              pressed: frame.pressed, axes: frame.axes },
          }));
        `,
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 },
    );
    const result = JSON.parse(stdout) as {
      resolved: string;
      functions: string[];
      modes: string[];
      globals: string[];
      held: string[];
      frame: object;
    };
    expect(result.resolved).toMatch(/\/packages\/render-three\/dist\/input\.js$/);
    expect(result.functions).toEqual(['function', 'function', 'function', 'function']);
    expect(result.modes).toEqual(['fps', 'iso', 'platformer']);
    expect(result.globals).toEqual(['undefined', 'undefined', 'undefined']);
    expect(result.held).toEqual([]);
    expect(result.frame).toEqual({
      tick: 12,
      actions: { Jump: true },
      pressed: ['Jump'],
      axes: { MoveX: 0.5 },
    });
  });

  it('has a closed browser graph with no Node, Three, dynamic import or render startup', () => {
    const modules = engineModules(repoRoot);
    const entry = modules.find((module) => module.specifier === specifier);
    expect(entry, 'the static exporter must resolve the public input subpath').toBeDefined();
    expect(entry!.entry).toBe(join(repoRoot, 'packages', 'render-three', 'dist', 'input.js'));
    const graph = collectModuleGraph({ entries: [entry!.entry], modules });
    expect(graph.files.map((file) => file.target)).toContain(
      'vendor/@aegis/render-three/dist/input.js',
    );
    expect(graph.files.length).toBeGreaterThan(2);
    expect(graph.deferred).toEqual([]);
    for (const file of graph.files) {
      expect(file.target).not.toMatch(
        /(?:^|\/)(?:three|dev-server|render|adapter|boot|static-boot|presentation-host)(?:\/|\.js$)/,
      );
      const imports = moduleSpecifiers(readFileSync(file.source, 'utf8'));
      expect(imports.dynamic, file.target).toEqual([]);
      expect(
        imports.statik.filter((name) => name.startsWith('node:') || /^three(?:\/|$)/.test(name)),
        file.target,
      ).toEqual([]);
    }
  });
});
