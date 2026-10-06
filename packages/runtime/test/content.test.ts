import { describe, expect, it } from 'vitest';
import { requireValue, success } from '../src/index.js';
import type {
  ContentPack,
  DeepReadonly,
  Outcome,
  RuntimeHost,
  RuntimeOptions,
} from '../src/index.js';
import { config, fixture, fixtureAdapter } from './fixture.js';
import type { Action, Config, State, View } from './fixture.js';

type Pack = DeepReadonly<ContentPack<Config>>;
type Host = RuntimeHost<State, Action, View, Config>;

/**
 * Literal goldens captured from the implementation that cloned the pack on every read, context
 * and commit (5949a7f). Sharing one frozen pack is a performance change only, so none may move;
 * if one does, the change altered what rules see or what a snapshot names.
 */
const R1_HASH = '26336423738c0ab5';
const R2_HASH = 'e3a526c1db0c76fa';
const GOLDEN_COMMITS: readonly string[] = [
  '1:action:488fcaa2d61fa7d3:action.finished:price:3',
  '2:turn:b306d49e53199a45::price:3',
  '3:turn:c5113712637f418a:job.ready,job.ready,job.ready,job.ready,action.finished:price:3',
  '4:action:132c4352f45fb2be:action.finished:price:3',
  '5:action:f967ef1ab7641147:reward.claimed,action.finished:price:3',
  '6:content:440b9c7a8a6e8a39:content.activated:price:7',
  '7:action:cb891d1d487a9105:action.finished:price:7',
  'restore:f967ef1ab7641147:price:3',
  '6:turn:3a59cb26124b90cd::price:3',
  '7:turn:05c8ae911c5afb16:action.finished:price:3',
  '8:content:22b67ff4a6b4e4f3::price:7',
  '9:action:e24f012ee5b117af:action.finished:price:7',
];
const GOLDEN_FINAL_HASH = 'e24f012ee5b117af';

const revised: ContentPack<Config> = {
  ...config,
  revision: 'r2',
  data: { ...config.data, price: 7 },
};

/** Attempt the write every case below tries: change a balance value through a frozen view. */
function overwritePrice(content: Pack): void {
  (content.data as { price: number }).price = 99;
}

describe('CONTENT: one frozen pack per installed revision (issue #7)', () => {
  it('refuses a write to content from any callback, atomically, and the pack stays intact', async () => {
    const base = fixtureAdapter();
    const [command] = base.commands;
    if (command === undefined) throw new Error('fixture command absent');
    const boundary = { ...base, canActivateContent: () => true };
    const activate = async (host: Host): Promise<Outcome<unknown>> => {
      requireValue(host.stageContent(revised));
      return host.activateContent(revised, 'boundary');
    };
    const cases: {
      readonly name: string;
      readonly code: string;
      readonly options: Partial<RuntimeOptions<State, Action, View, Config>>;
      readonly run: (host: Host) => Promise<Outcome<unknown>>;
    }[] = [
      {
        name: 'resolve',
        code: 'transition-failed',
        options: {
          adapter: {
            ...base,
            resolve(action, context) {
              overwritePrice(context.content);
              return base.resolve(action, context);
            },
          },
        },
        run: (host) => host.dispatch({ type: 'purchase' }),
      },
      {
        name: 'command rule',
        code: 'transition-failed',
        options: {
          adapter: {
            ...base,
            commands: [
              {
                ...command,
                start(context) {
                  overwritePrice(context.content);
                },
              },
            ],
          },
        },
        run: (host) => host.dispatch({ type: 'purchase' }),
      },
      {
        name: 'view projection',
        code: 'transition-failed',
        options: {
          adapter: {
            ...base,
            view(read) {
              if (read.revision > 0) overwritePrice(read.content);
              return base.view(read);
            },
          },
        },
        run: (host) => host.dispatch({ type: 'purchase' }),
      },
      {
        name: 'prepareRestore',
        code: 'restore-failed',
        options: {
          prepareRestore: async (_snapshot, content) => {
            overwritePrice(content);
            return success(undefined);
          },
        },
        run: (host) => host.restore(host.snapshot()),
      },
      {
        name: 'canActivateContent candidate',
        code: 'transition-failed',
        options: {
          adapter: {
            ...boundary,
            canActivateContent(_read, candidate) {
              overwritePrice(candidate);
              return true;
            },
          },
        },
        run: activate,
      },
      {
        name: 'activateContent previous',
        code: 'transition-failed',
        options: {
          adapter: {
            ...boundary,
            activateContent(_context, previous) {
              overwritePrice(previous);
            },
          },
        },
        run: activate,
      },
    ];
    for (const entry of cases) {
      const host = fixture(undefined, entry.options);
      const before = host.snapshot();
      const outcome = await entry.run(host);
      expect(outcome, entry.name).toMatchObject({ ok: false, error: { code: entry.code } });
      expect(JSON.stringify(outcome), entry.name).toContain('read only property');
      expect(host.snapshot(), entry.name).toEqual(before);
      expect(host.inspect().content.data.price, entry.name).toBe(3);
    }
    const host = fixture();
    const read = host.inspect();
    expect(() => overwritePrice(read.content)).toThrow(TypeError);
    expect(() => {
      (read.content.data.costs as { two: number }).two = 0;
    }).toThrow(TypeError);
    expect(() => Object.assign(read.content.data, { extra: 1 })).toThrow(TypeError);
    expect(() => delete (read.content.data as { jobDelay?: number }).jobDelay).toThrow(TypeError);
    requireValue(await host.dispatch({ type: 'purchase' }));
    expect(host.inspect().state.charged).toBe(3);
    expect(host.inspect().content).toEqual(config);
  });

  it('never freezes or aliases a pack the caller owns', async () => {
    const authored = structuredClone(config) as ContentPack<Config>;
    const host = fixture(undefined, { content: authored });
    expect(Object.isFrozen(authored)).toBe(false);
    expect(Object.isFrozen(authored.data)).toBe(false);
    authored.data.price = 50;
    expect(host.inspect().content.data.price).toBe(3);

    const candidate = structuredClone(revised) as ContentPack<Config>;
    const staged = requireValue(host.stageContent(candidate));
    expect(staged).not.toBe(candidate);
    expect(staged).toEqual(revised);
    expect(Object.isFrozen(staged)).toBe(false);
    expect(Object.isFrozen(staged.data)).toBe(false);
    expect(Object.isFrozen(candidate.data)).toBe(false);
    staged.data.price = 60;
    candidate.data.price = 70;

    const activation = structuredClone(revised) as ContentPack<Config>;
    requireValue(await host.activateContent(activation, 'restart'));
    expect(Object.isFrozen(activation.data)).toBe(false);
    activation.data.price = 80;
    expect(host.inspect().content).toEqual(revised);
    expect(host.snapshot().content.hash).toBe(R2_HASH);
    requireValue(await host.dispatch({ type: 'purchase' }));
    expect(host.inspect().state.charged).toBe(7);
  });

  it('pins every commit, its view and the restored view through activation and restore', async () => {
    const base = fixtureAdapter();
    const trajectory: string[] = [];
    const host = fixture(undefined, {
      adapter: {
        ...base,
        // The projection reads content as well, so a view built from the wrong pack moves a golden.
        view: (read) => ({ ...base.view(read), log: [`price:${read.content.data.price}`] }),
        activateContent(context, previous) {
          context.state.log.push(`content:${previous.revision}->${context.content.revision}`);
          context.emit('content.activated', {
            from: previous.data.price,
            to: context.content.data.price,
          });
        },
      },
    });
    host.subscribeCommits((commit) => {
      const events = commit.events.map((event) => event.type).join(',');
      const view = commit.view.log.join(',');
      trajectory.push(`${commit.revision}:${commit.kind}:${commit.hash}:${events}:${view}`);
    });
    requireValue(await host.dispatch({ type: 'begin' }));
    requireValue(await host.dispatch({ type: 'two' }));
    requireValue(await host.dispatch({ type: 'phase' }));
    requireValue(await host.dispatch({ type: 'claim' }));
    const saved = host.snapshot();
    expect(saved.content).toEqual({
      id: 'fixture',
      revision: 'r1',
      schemaVersion: 1,
      hash: R1_HASH,
    });
    requireValue(host.stageContent(revised));
    requireValue(await host.activateContent(revised, 'boundary'));
    expect(host.snapshot().content.hash).toBe(R2_HASH);
    requireValue(await host.dispatch({ type: 'purchase' }));
    requireValue(await host.restore(saved));
    trajectory.push(`restore:${host.hash()}:${host.getView().log.join(',')}`);
    requireValue(await host.dispatch({ type: 'two' }));
    requireValue(await host.activateContent(revised, 'restart'));
    requireValue(await host.dispatch({ type: 'purchase' }));
    expect(trajectory).toEqual(GOLDEN_COMMITS);
    expect(host.hash()).toBe(GOLDEN_FINAL_HASH);
  });
});
