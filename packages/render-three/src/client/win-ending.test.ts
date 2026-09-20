import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, Group, VectorKeyframeTrack } from 'three';
import { EndingScene } from '../presentation/ending-scene.js';
import type { PresentationAssets } from '../presentation/assets.js';
import type { WinEndingSpec } from '../presentation/schema.js';
import { createWinEnding } from './win-ending.js';
import type { WinEnding } from './win-ending.js';

class Element extends EventTarget {
  textContent = '';
  hidden = false;
  dataset: Record<string, string> = {};
  style = { opacity: '' };
  attributes: Record<string, string> = {};
  focus = vi.fn();
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}
class Dialog extends Element {
  open = false;
  showModal = vi.fn(() => {
    this.open = true;
  });
  close(): void {
    this.open = false;
  }
}
class Button extends Element {
  disabled = false;
}
class Key extends Event {
  constructor(
    readonly code: string,
    readonly repeat = false,
    type = 'keydown',
  ) {
    super(type, { cancelable: true });
  }
}
let ending: WinEnding | undefined;
afterEach(() => {
  ending?.dispose();
  ending = undefined;
  vi.unstubAllGlobals();
});
function setup() {
  vi.stubGlobal('HTMLDialogElement', Dialog);
  vi.stubGlobal('HTMLButtonElement', Button);
  vi.stubGlobal('KeyboardEvent', Key);
  const dialog = new Dialog();
  const nodes: Record<string, Element> = { 'win-ending': dialog };
  for (const id of [
    'game-shell',
    'win-shade',
    'win-card',
    'win-caption',
    'win-error',
    'win-skip',
    'win-pause',
    'win-mute',
    'win-restart',
  ])
    nodes[id] = new Button();
  const canvas = new Element();
  const root = Object.assign(new EventTarget(), {
    hidden: false,
    pointerLockElement: canvas as Element | null,
    getElementById: (id: string) => nodes[id] ?? null,
    exitPointerLock: vi.fn(() => {
      root.pointerLockElement = null;
    }),
  });
  const model = new Group();
  model.add(
    Object.assign(new Group(), { name: 'eye' }),
    Object.assign(new Group(), { name: 'target' }),
  );
  const release = vi.fn();
  const assets: PresentationAssets = {
    instantiateModel: () => ({
      root: model,
      clips: [
        new AnimationClip('Departure', 10, [
          new VectorKeyframeTrack('eye.position', [0, 10], [0, 1, 5, 0, 2, 10]),
        ]),
      ],
      dispose: release,
    }),
    texture: vi.fn(),
    material: vi.fn(),
    audio: vi.fn(),
    stats: vi.fn(),
    dispose: vi.fn(),
  };
  const spec: WinEndingSpec = {
    model: 'ending',
    clip: 'Departure',
    camera: { eye: 'eye', target: 'target' },
    title: 'Safe',
    message: 'Home.',
    captions: [
      { startSeconds: 0, endSeconds: 3, text: 'Sealing' },
      { startSeconds: 4, endSeconds: 8, text: 'Separated' },
    ],
    cues: [{ atSeconds: 4, event: 'presentation.separation' }],
  };
  const view = new EndingScene(assets, spec);
  const blocked = vi.fn(),
    restart = vi.fn(),
    cue = vi.fn(),
    mute = vi.fn();
  ending = createWinEnding({
    spec,
    view,
    canvas: canvas as unknown as HTMLCanvasElement,
    root: root as unknown as Document,
    onGameplayBlocked: blocked,
    onRestart: restart,
    onMute: mute,
    onCue: cue,
  });
  return { ending, nodes, dialog, root, blocked, restart, cue, mute, release };
}
function click(nodes: Record<string, Element>, id: string): void {
  nodes[id]!.dispatchEvent(new Event('click'));
}
describe('win cutscene playback lifecycle', () => {
  it('runs once per outcome, drives timed captions/audio, then persists until a real restart', () => {
    const { ending, nodes, dialog, root, blocked, restart, cue } = setup();
    ending.outcome('lose');
    expect(dialog.open).toBe(false);
    ending.outcome('win');
    ending.outcome('win');
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(root.exitPointerLock).toHaveBeenCalledOnce();
    expect(blocked).toHaveBeenCalledExactlyOnceWith(true);
    ending.advance(100, false);
    expect(nodes['win-caption']!.textContent).toBe('Sealing');
    ending.advance(4100, false);
    expect(cue).toHaveBeenCalledExactlyOnceWith('presentation.separation');
    expect(nodes['win-caption']!.textContent).toBe('Separated');
    ending.advance(9000, false);
    expect(Number(nodes['win-shade']!.style.opacity)).toBeGreaterThan(0);
    ending.advance(10100, false);
    expect(ending.state().phase).toBe('shown');
    expect(nodes['win-card']!.hidden).toBe(false);
    ending.advance(90000, false);
    expect(cue).toHaveBeenCalledOnce();
    click(nodes, 'win-restart');
    click(nodes, 'win-restart');
    expect(restart).toHaveBeenCalledOnce();
    ending.reportError('Restart failed');
    expect(ending.state().phase).toBe('shown');
    expect(nodes['win-error']!.textContent).toBe('Restart failed');
    ending.outcome(undefined);
    expect(dialog.open).toBe(false);
    expect(blocked).toHaveBeenLastCalledWith(false);
    ending.outcome('win');
    ending.advance(0, false);
    ending.advance(4000, false);
    expect(cue).toHaveBeenCalledTimes(2);
  });
  it('holds its clock for local/session pause and hidden tabs without catching up', () => {
    const { ending, nodes, root, cue } = setup();
    ending.outcome('win');
    ending.advance(0, false);
    ending.advance(1000, false);
    click(nodes, 'win-pause');
    ending.advance(10000, false);
    expect(ending.state().seconds).toBe(1);
    click(nodes, 'win-pause');
    ending.advance(11000, false);
    expect(ending.state().seconds).toBe(1);
    ending.advance(50000, true);
    ending.advance(60000, false);
    expect(ending.state().seconds).toBe(1);
    root.hidden = true;
    root.dispatchEvent(new Event('visibilitychange'));
    root.hidden = false;
    root.dispatchEvent(new Event('visibilitychange'));
    ending.advance(120000, false);
    expect(ending.state().seconds).toBe(1);
    ending.advance(123000, false);
    expect(cue).toHaveBeenCalledOnce();
  });
  it.each([
    { name: 'exactly four seconds', before: 3999, after: 4000, calls: 1 },
    { name: 'inclusive 250ms grace', before: 3999, after: 4250, calls: 1 },
    { name: '251ms is too late', before: 3999, after: 4251, calls: 0 },
    { name: 'Ubuntu live crossing', before: 3688.6, after: 4355.6, calls: 0 },
    { name: 'Ubuntu static crossing', before: 3906.1, after: 4377.4, calls: 0 },
  ])('consumes the cue once without replaying missed speech: $name', ({ before, after, calls }) => {
    const { ending, cue, nodes } = setup();
    ending.outcome('win');
    ending.advance(0, false);
    ending.advance(before, false);
    expect(cue).not.toHaveBeenCalled();
    ending.advance(after, false);
    expect(cue).toHaveBeenCalledTimes(calls);
    expect(nodes['win-caption']!.textContent).toBe('Separated');
    ending.advance(6000, false);
    ending.advance(10000, false);
    expect(cue).toHaveBeenCalledTimes(calls);
    expect(ending.state().phase).toBe('shown');
    ending.outcome(undefined);
    ending.outcome('win');
    ending.advance(0, false);
    ending.advance(4000, false);
    expect(cue).toHaveBeenCalledTimes(calls + 1);
  });
  it('skip, reduced motion and large display gaps never burst missed cues', () => {
    const { ending, nodes, cue } = setup();
    ending.outcome('win');
    click(nodes, 'win-skip');
    ending.advance(20000, false);
    expect(ending.state().phase).toBe('shown');
    expect(cue).not.toHaveBeenCalled();
    ending.outcome(undefined);
    ending.outcome('win', true);
    ending.advance(20000, false);
    expect(ending.state()).toMatchObject({ phase: 'shown', seconds: 0 });
    expect(cue).not.toHaveBeenCalled();
    ending.outcome(undefined);
    ending.setReducedMotion(true);
    ending.outcome('win');
    expect(ending.state()).toMatchObject({ phase: 'shown', seconds: 0, reducedMotion: true });
    ending.outcome(undefined);
    ending.setReducedMotion(false);
    ending.outcome('win');
    ending.advance(0, false);
    ending.advance(7000, false);
    expect(cue).not.toHaveBeenCalled();
  });
  it('guards held activation, keeps mute accessible, prevents dismissal and removes owned listeners', () => {
    const { ending, dialog, nodes, mute, release } = setup();
    ending.outcome('win');
    const held = new Key('Enter', true);
    dialog.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    const releaseKey = new Key('Space', false, 'keyup');
    dialog.dispatchEvent(releaseKey);
    expect(releaseKey.defaultPrevented).toBe(true);
    click(nodes, 'win-mute');
    expect(mute).toHaveBeenCalledOnce();
    ending.setAudio({ status: 'ready', muted: true, voices: 0, dropped: 0 });
    expect(nodes['win-mute']!.textContent).toBe('Unmute');
    ending.setAudio({ status: 'unavailable', muted: false, voices: 0, dropped: 0 });
    expect(nodes['win-mute']!.attributes['aria-disabled']).toBe('true');
    ending.setAudio({
      status: 'error',
      muted: false,
      voices: 0,
      dropped: 0,
      error: 'Decode failed',
    });
    expect(nodes['win-mute']!.textContent).toBe('Retry sound');
    expect(nodes['win-error']!.textContent).toBe('Audio: Decode failed');
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(ending.state().phase).toBe('shown');
    expect(dialog.open).toBe(true);
    ending.dispose();
    ending.dispose();
    expect(release).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    click(nodes, 'win-mute');
    expect(mute).toHaveBeenCalledOnce();
  });
});
