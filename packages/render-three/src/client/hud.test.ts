import { describe, expect, it } from 'vitest';
import { createWorld, defineComponent, Name, Transform } from '@aegis/core';
import { Health } from '@aegis/content';
import { PlatformerController } from '@aegis/mode-platformer';
import { Controlled, GridPosition } from '@aegis/mode-iso';
import { FpsCamera, LookState } from '@aegis/mode-fps';
import type { HudSpec } from '../presentation/schema.js';
import { createHud } from './hud.js';

class Element {
  #text = '';
  writes = 0;
  hidden = false;
  disabled = false;
  open = false;
  attributes = new Map<string, string>();
  get textContent(): string {
    return this.#text;
  }
  set textContent(value: string) {
    this.#text = value;
    this.writes++;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

const IDS = [
  'hud-tick',
  'hud-status',
  'hud-stats',
  'hud-events',
  'hud-objective',
  'hud-prompt',
  'hud-subtitle',
  'hud-narrative-status',
  'hud-health',
  'hud-health-bar',
  'health-readout',
  'hud-progress',
  'hud-outcome',
  'hud-step-0',
  'hud-step-1',
  'action-pause',
  'action-mute',
  'hud-audio',
  'session-menu',
  'loading-panel',
  'loading-title',
  'loading-message',
  'action-retry',
  'stage',
];
function dom(ids: readonly string[] = IDS) {
  const elements = new Map(ids.map((id) => [id, new Element()]));
  const root = {
    getElementById: (id: string) => elements.get(id) ?? null,
  } as unknown as Document;
  return { root, get: (id: string) => elements.get(id)! };
}

const SPEC: HudSpec = {
  playerName: 'navigator',
  winEvent: 'expedition.complete',
  loseEvents: ['expedition.failed', 'crew.lost'],
  steps: [
    { id: 'power', label: 'Restore power', event: 'power.restored' },
    { id: 'route', label: 'Chart the route', event: 'route.charted' },
  ],
};

describe('game-facing HUD', () => {
  it('announces only the first authoritative outcome until reset and preserves first-win precedence', () => {
    const { root } = dom();
    const outcomes: ('win' | 'lose' | undefined)[] = [];
    const hud = createHud(root, { spec: SPEC, onOutcome: (value) => outcomes.push(value) });
    hud.pushEvents([{ type: 'crew.lost', tick: 1, sequence: 0 }]);
    hud.pushEvents([
      { type: 'crew.lost', tick: 1, sequence: 0 },
      { type: 'crew.lost', tick: 2, sequence: 1 },
    ]);
    expect(outcomes).toEqual(['lose']);
    hud.reset();
    hud.pushEvents([
      { type: 'expedition.complete', tick: 1, sequence: 0 },
      { type: 'crew.lost', tick: 2, sequence: 1 },
    ]);
    expect(outcomes).toEqual(['lose', undefined, 'win']);
  });
  it('opens an opt-in compact session menu when sound fails, keeping the error visible', () => {
    const { root, get } = dom();
    const hud = createHud(root);
    expect(get('session-menu').open).toBe(false);
    hud.setAudio({ status: 'error', muted: false, error: 'Required sound could not decode' });
    expect(get('session-menu').open).toBe(true);
    expect(get('hud-audio').textContent).toBe('Required sound could not decode');
  });
  it('reads generic narrative fields and expires accessible captions without mutating simulation', () => {
    const Status = defineComponent({
      id: 'Narrative',
      defaults: () => ({
        objective: 'Find the relay',
        prompt: '[E] Restore power',
        subtitle: 'Stay quiet',
        until: 5,
        threat: 'Listening',
      }),
    });
    const world = createWorld({ seed: 'narrative' });
    const player = world.spawn(Name({ value: 'navigator' }), Status());
    const field = (field: string) => ({ entity: 'navigator', component: 'Narrative', field });
    const { root, get } = dom();
    const hud = createHud(root, {
      spec: {
        ...SPEC,
        bindings: {
          objective: field('objective'),
          prompt: field('prompt'),
          subtitle: field('subtitle'),
          subtitleUntil: field('until'),
          status: field('threat'),
        },
      },
    });
    const hash = world.hash();
    hud.setCaption({ text: 'A pipe creaks', speaker: 'Environment', durationTicks: 10 }, 0);
    hud.setStats('fps', world);
    expect(get('hud-objective').textContent).toBe('Find the relay');
    expect(get('hud-prompt').textContent).toBe('[E] Restore power');
    expect(get('hud-narrative-status').textContent).toBe('Listening');
    expect(get('hud-subtitle').textContent).toBe('Stay quiet');
    expect(world.hash()).toBe(hash);
    world.getOrThrow(player, Status).until = 0;
    hud.setStats('fps', world);
    expect(get('hud-subtitle').textContent).toBe('Environment: A pipe creaks');
    hud.reset();
    expect(get('hud-subtitle').hidden).toBe(true);
    expect(get('hud-prompt').hidden).toBe(true);
  });
  it('reads health from the manifest-named actor, not the first damageable or mode controller', () => {
    const { root, get } = dom();
    const hud = createHud(root, { spec: SPEC, objective: 'Bring everyone home' });
    const world = createWorld({ seed: 'hud' });
    world.spawn(Name({ value: 'other' }), Health({ current: 2, max: 10 }), PlatformerController());
    const player = world.spawn(Name({ value: 'navigator' }), Health({ current: 37, max: 80 }));
    const before = world.hash();
    hud.setStats('platformer', world);
    expect(get('hud-objective').textContent).toBe('Bring everyone home');
    expect(get('hud-health').textContent).toBe('37 / 80');
    expect(get('health-readout').hidden).toBe(false);
    expect(get('hud-health-bar').getAttribute('max')).toBe('80');
    expect(get('hud-health-bar').getAttribute('value')).toBe('37');
    expect(get('hud-health-bar').getAttribute('aria-valuetext')).toBe('37 of 80 health');
    expect(world.hash()).toBe(before);
    world.despawn(player);
    hud.setStats('platformer', world);
    expect(get('health-readout').hidden).toBe(true);
    expect(get('hud-health').textContent).toBe('—');
  });

  it('preserves the existing mode diagnostic meanings and controller-based default health', () => {
    const { root, get } = dom();
    const hud = createHud(root);
    const world = createWorld({ seed: 'hud-defaults' });
    world.spawn(
      PlatformerController(),
      Transform({ position: { x: 1.25, y: 4.5, z: 0 } }),
      Health({ current: 9, max: 10 }),
    );
    hud.setStats('platformer', world);
    expect(get('hud-stats').textContent).toBe('x 1.25   y 4.50');
    expect(get('hud-health').textContent).toBe('9 / 10');

    world.spawn(
      Controlled(),
      GridPosition({ cellX: 2, cellY: 3 }),
      Health({ current: 20, max: 30 }),
    );
    world.spawn(GridPosition({ cellX: 8, cellY: 5 }), Health({ current: 4, max: 12 }));
    hud.setStats('iso', world);
    expect(get('hud-stats').textContent).toBe('operative (2,3) hp 20/30\nguard (8,5) hp 4/12');
    expect(get('hud-health').textContent).toBe('20 / 30');

    world.spawn(
      FpsCamera(),
      LookState({ yawDeg: 45, pitchDeg: -8 }),
      Transform({ position: { x: 1, y: 1.6, z: 9 } }),
      Health({ current: 60, max: 100 }),
    );
    hud.setStats('fps', world);
    expect(get('hud-stats').textContent).toBe(
      'x 1.0  y 1.6  z 9.0\nyaw 45°  pitch -8°   hp 60/100',
    );
    expect(get('hud-health').textContent).toBe('60 / 100');
  });

  it('advances authored steps only on their named events, independently of diagnostics DOM', () => {
    const { root, get } = dom(IDS.filter((id) => id !== 'hud-events'));
    const hud = createHud(root, { spec: SPEC });
    expect(get('hud-progress').textContent).toBe('0 / 2 complete');
    expect(get('hud-step-0').textContent).toBe('Restore power');
    hud.pushEvents([
      { type: 'route.charted', tick: 2 },
      { type: 'unrelated', tick: 3 },
    ]);
    expect(get('hud-progress').textContent).toBe('1 / 2 complete');
    expect(get('hud-step-1').textContent).toBe('✓ Chart the route');
    expect(get('hud-step-1').getAttribute('data-complete')).toBe('true');
    hud.pushEvents([
      { type: 'route.charted', tick: 4 },
      { type: 'power.restored', tick: 5 },
    ]);
    expect(get('hud-progress').textContent).toBe('2 / 2 complete');
  });

  it('reports configured outcomes without pausing, and keeps the first outcome until reset', () => {
    const { root, get } = dom();
    const hud = createHud(root, { spec: SPEC });
    hud.setStatus(10, false, 59.8);
    hud.pushEvents([{ type: 'level.completed', tick: 10 }]);
    expect(get('hud-outcome').textContent).toBe('');
    hud.pushEvents([
      { type: 'expedition.complete', tick: 11 },
      { type: 'crew.lost', tick: 12 },
    ]);
    expect(get('hud-outcome').textContent).toBe('Objective complete');
    expect(get('hud-outcome').getAttribute('data-outcome')).toBe('win');
    expect(get('hud-outcome').hidden).toBe(false);
    expect(get('action-pause').textContent).toBe('Pause');
    expect(get('hud-status').textContent).toBe('60 fps');
    hud.reset();
    hud.pushEvents([{ type: 'crew.lost', tick: 1 }]);
    expect(get('hud-outcome').textContent).toBe('Run ended · try again');
    expect(get('hud-outcome').getAttribute('data-outcome')).toBe('lose');
  });

  it('keeps an eight-line event feed, retaining distinct same-tick sequenced events exactly once', () => {
    const { root, get } = dom();
    const hud = createHud(root);
    const events = Array.from({ length: 10 }, (_, sequence) => ({
      type: 'sample',
      tick: 4,
      sequence,
    }));
    hud.pushEvents(events);
    expect(get('hud-events').textContent.split('\n')).toEqual(Array(8).fill('   4  sample'));
    const writes = get('hud-events').writes;
    hud.pushEvents(structuredClone(events));
    expect(get('hud-events').writes).toBe(writes);
    hud.pushEvents([{ type: 'next', tick: 5, sequence: 10 }]);
    expect(get('hud-events').textContent.split('\n').at(-1)).toBe('   5  next');
  });

  it('clears run-local state while preserving objective, pause, audio and quality preferences', () => {
    const { root, get } = dom();
    const hud = createHud(root, { spec: SPEC, objective: 'Bring everyone home' });
    hud.setStatus(40, true, 60);
    hud.setAudio({ status: 'ready', muted: true });
    hud.pushEvents([
      { type: 'power.restored', tick: 20, sequence: 0 },
      { type: 'expedition.complete', tick: 40, sequence: 1 },
    ]);
    hud.reset();
    expect(get('hud-tick').textContent).toBe('tick 0');
    expect(get('hud-status').textContent).toBe('starting…');
    expect(get('hud-stats').textContent).toBe('');
    expect(get('hud-events').textContent).toBe('');
    expect(get('hud-progress').textContent).toBe('0 / 2 complete');
    expect(get('hud-step-0').textContent).toBe('Restore power');
    expect(get('hud-outcome').hidden).toBe(true);
    expect(get('hud-objective').textContent).toBe('Bring everyone home');
    expect(get('hud-audio').textContent).toBe('Sound muted');
    expect(get('action-pause').textContent).toBe('Resume');
    expect(get('action-pause').getAttribute('aria-pressed')).toBe('true');
    expect(get('action-pause').getAttribute('aria-label')).toBe('Resume game');
    hud.pushEvents([{ type: 'power.restored', tick: 1, sequence: 0 }]);
    expect(get('hud-progress').textContent).toBe('1 / 2 complete');
  });

  it('updates pause text and the pressed state, retaining the original tick/fps strings', () => {
    const { root, get } = dom();
    const hud = createHud(root);
    hud.setStatus(12, false, 59.6);
    expect(get('hud-tick').textContent).toBe('tick 12');
    expect(get('hud-status').textContent).toBe('60 fps');
    expect(get('action-pause').getAttribute('aria-pressed')).toBe('false');
    hud.setStatus(12, true, 0);
    expect(get('hud-status').textContent).toBe('paused');
    expect(get('action-pause').textContent).toBe('Resume');
    expect(get('action-pause').getAttribute('aria-label')).toBe('Resume game');
    expect(get('action-pause').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('HUD loading, audio and low-churn DOM updates', () => {
  it('shows loading/failure/reconnect states and removes the loading overlay only when ready', () => {
    const { root, get } = dom();
    const hud = createHud(root);
    hud.setLoading('loading', 'Loading assets 2/4');
    expect(get('loading-panel').hidden).toBe(false);
    expect(get('loading-message').textContent).toBe('Loading assets 2/4');
    expect(get('action-retry').hidden).toBe(true);
    expect(get('stage').getAttribute('aria-busy')).toBe('true');
    hud.setLoading('error', 'Asset <missing> could not load');
    expect(get('loading-title').textContent).toBe('Unable to start');
    expect(get('loading-message').textContent).toBe('Asset <missing> could not load');
    expect(get('action-retry').hidden).toBe(false);
    expect(get('loading-panel').getAttribute('data-state')).toBe('error');
    hud.setLoading('reconnecting', 'Connection interrupted. Retrying.');
    expect(get('loading-title').textContent).toBe('Reconnecting');
    expect(get('loading-panel').hidden).toBe(false);
    hud.setLoading('ready', '');
    expect(get('loading-panel').hidden).toBe(true);
    expect(get('action-retry').hidden).toBe(true);
    expect(get('stage').getAttribute('aria-busy')).toBe('false');
  });

  it('renders honest locked, muted, unavailable and error audio states', () => {
    const { root, get } = dom();
    const hud = createHud(root);
    hud.setAudio({ status: 'locked', muted: false });
    expect(get('action-mute').textContent).toBe('Enable sound');
    expect(get('hud-audio').textContent).toBe('Sound needs a gesture');
    hud.setAudio({ status: 'ready', muted: true });
    expect(get('action-mute').textContent).toBe('Unmute');
    expect(get('action-mute').getAttribute('aria-pressed')).toBe('true');
    hud.setAudio({ status: 'unavailable', muted: false, error: 'No sound device' });
    expect(get('action-mute').disabled).toBe(true);
    expect(get('hud-audio').textContent).toBe('No sound device');
    hud.setAudio({ status: 'error', muted: false, error: 'Audio decode failed' });
    expect(get('action-mute').disabled).toBe(false);
    expect(get('action-mute').textContent).toBe('Retry sound');
    expect(get('hud-audio').textContent).toBe('Audio decode failed');
    hud.setAudio({ status: 'ready', muted: false });
    expect(get('action-mute').textContent).toBe('Mute');
    expect(get('hud-audio').textContent).toBe('Sound on');
  });

  it('does not rewrite identical text on repeated frames or repeated state notifications', () => {
    const { root, get } = dom();
    const hud = createHud(root, { spec: SPEC });
    const world = createWorld({ seed: 'hud-writes' });
    world.spawn(Name({ value: 'navigator' }), Health({ current: 40, max: 50 }));
    const update = () => {
      hud.setStats('iso', world);
      hud.setStatus(20, false, 60);
      hud.setLoading('ready', '');
      hud.setAudio({ status: 'ready', muted: false });
      hud.pushEvents([]);
    };
    update();
    const writes = IDS.map((id) => get(id).writes);
    update();
    expect(IDS.map((id) => get(id).writes)).toEqual(writes);
  });

  it('works when optional chrome is absent, including old text-only fake elements', () => {
    const elements = new Map(
      ['hud-tick', 'hud-status', 'hud-stats', 'hud-events'].map((id) => [id, { textContent: '' }]),
    );
    const root = {
      getElementById: (id: string) => elements.get(id) ?? null,
    } as unknown as Document;
    const hud = createHud(root, { spec: SPEC });
    hud.setStats('platformer', createWorld({ seed: 'empty' }));
    hud.setStatus(1, false, 60);
    hud.pushEvents([{ type: 'power.restored', tick: 1 }]);
    hud.setLoading('error', 'visible in richer chrome');
    hud.setAudio({ status: 'ready', muted: false });
    expect(elements.get('hud-events')?.textContent).toBe('   1  power.restored');
    hud.reset();
    expect(elements.get('hud-tick')?.textContent).toBe('tick 0');
  });
});
