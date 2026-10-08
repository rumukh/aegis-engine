import { BrowserServiceError } from '../errors.js';
import type { CameraTarget, CutsceneFile, CutsceneStep, Easing, Placement, Vec2 } from './types.js';

/** How a line step ended. `failed` covers blocked and failed narration: the caption stays readable. */
export type LineOutcome = 'pending' | 'completed' | 'failed';
export interface LineHandle {
  outcome(): LineOutcome;
}
export interface StepOptions {
  /** Apply the end state at once: no motion, no narration, no sound (skip and fast-forward). */
  instant: boolean;
}

/**
 * What a cutscene needs from its stage. Every operation returns how long it blocks, in seconds
 * of stage time. The stage owns reduced motion: it may turn moves into cuts or fades and return
 * shorter durations.
 */
export interface CutsceneHost {
  reset(): void;
  background(
    asset: string,
    transition: { type: 'cut' | 'crossfade'; duration: number },
    options: StepOptions,
  ): number;
  camera(
    target: CameraTarget | string,
    motion: { duration: number; ease?: Easing; cut: boolean },
    options: StepOptions,
  ): number;
  enter(
    actor: string,
    from: Placement,
    to: Vec2,
    motion: { duration?: number; walk: boolean; ease?: Easing },
    options: StepOptions,
  ): number;
  exit(
    actor: string,
    to: Placement,
    motion: { duration?: number; walk: boolean; ease?: Easing },
    options: StepOptions,
  ): number;
  move(
    actor: string,
    path: readonly Vec2[],
    motion: { duration?: number; speed?: number; walk: boolean; ease?: Easing },
    options: StepOptions,
  ): number;
  pose(
    actor: string,
    pose: { expression?: string; clip?: string; face?: 'left' | 'right' },
    options: StepOptions,
  ): number;
  emote(actor: string, emote: string, options: StepOptions): number;
  /** Start a narration line with lip-sync for `actor`; never called for instant steps. */
  line(actor: string | undefined, line: string): LineHandle;
  stopLine(): void;
  music(asset: string | null, fade: number, options: StepOptions): void;
  atmosphere(asset: string | null, fade: number, options: StepOptions): void;
  sfx(asset: string, gain: number): void;
  effect(effect: string, at: Vec2 | undefined, duration: number, options: StepOptions): number;
  transition(
    type: 'fade' | 'crossfade',
    duration: number,
    color: string,
    options: StepOptions,
  ): number;
  /** Finish every running motion at once (skip). */
  settle(): void;
}

export type CutsceneEvent =
  | { type: 'started'; cutscene: string; from?: string }
  | { type: 'step'; index: number; op: CutsceneStep['op'] }
  | { type: 'line'; index: number; line: string; actor?: string }
  | { type: 'line-ended'; index: number; line: string; outcome: Exclude<LineOutcome, 'pending'> }
  | { type: 'awaiting-input'; index: number }
  | { type: 'marker'; id: string }
  | { type: 'paused'; reasons: readonly string[] }
  | { type: 'resumed' }
  | { type: 'completed'; cutscene: string }
  | { type: 'skipped'; cutscene: string };

export type CutsceneStatus =
  'idle' | 'playing' | 'awaiting-input' | 'paused' | 'completed' | 'skipped';

type Waiting =
  | { kind: 'time'; until: number }
  | { kind: 'line'; handle: LineHandle; advance: 'input' | 'auto'; index: number; line: string }
  | { kind: 'input'; index: number }
  | { kind: 'join' };

const NON_BLOCKING = new Set(['music', 'atmosphere', 'sfx', 'marker']);

/**
 * Plays a cutscene against a host (ANIM-05). Presentation only: it emits events and never
 * touches runtime state. The consumer commits "completed" or "skipped" with an ordinary command.
 */
export class CutscenePlayer {
  private index = 0;
  private waiting?: Waiting;
  private running: number[] = [];
  private pausedReasons = new Set<string>();
  private state: CutsceneStatus = 'idle';
  private lastMarker?: string;

  constructor(
    readonly cutscene: CutsceneFile,
    private readonly host: CutsceneHost,
    private readonly options: {
      onEvent?(event: CutsceneEvent): void;
      comfort?(): boolean;
    } = {},
  ) {}

  status(): CutsceneStatus {
    return this.pausedReasons.size && (this.state === 'playing' || this.state === 'awaiting-input')
      ? 'paused'
      : this.state;
  }
  /** The last marker passed, for consumers that persist a restart point. */
  marker(): string | undefined {
    return this.lastMarker;
  }
  stepIndex(): number {
    return this.index;
  }

  private emit(event: CutsceneEvent): void {
    this.options.onEvent?.(event);
  }

  private resolve(step: CutsceneStep): CutsceneStep {
    return step.comfort && this.options.comfort?.()
      ? ({ ...step, ...step.comfort } as CutsceneStep)
      : step;
  }

  /** Start from the beginning, or apply every step before `from` instantly and start there. */
  play(now: number, options: { from?: string } = {}): void {
    this.host.reset();
    this.host.stopLine();
    this.index = 0;
    this.waiting = undefined;
    this.running = [];
    this.lastMarker = undefined;
    this.state = 'playing';
    if (options.from !== undefined) {
      const target = this.cutscene.steps.findIndex(
        (step) => step.op === 'marker' && step.id === options.from,
      );
      if (target < 0)
        throw new BrowserServiceError('invalid-data', `Unknown marker "${options.from}".`);
      while (this.index <= target)
        this.execute(this.cutscene.steps[this.index]!, this.index++, now, true);
      this.host.settle();
    }
    this.emit({
      type: 'started',
      cutscene: this.cutscene.id,
      ...(options.from ? { from: options.from } : {}),
    });
    this.update(now);
  }

  replay(now: number): void {
    this.play(now);
  }

  pause(reason: string): void {
    const before = this.pausedReasons.size;
    this.pausedReasons.add(reason);
    if (!before) this.emit({ type: 'paused', reasons: [...this.pausedReasons] });
  }
  resume(reason: string): void {
    if (!this.pausedReasons.delete(reason) || this.pausedReasons.size) return;
    this.emit({ type: 'resumed' });
  }

  /** The child's "next": continues a step waiting for input. Returns whether it advanced. */
  next(now: number): boolean {
    if (this.pausedReasons.size || this.waiting?.kind !== 'input') return false;
    this.waiting = undefined;
    this.state = 'playing';
    this.update(now);
    return true;
  }

  /** Jump to the declared end state: every remaining step applied instantly, no narration. */
  skip(now: number): void {
    if (this.state === 'completed' || this.state === 'skipped' || this.state === 'idle') return;
    this.host.stopLine();
    this.host.settle();
    this.waiting = undefined;
    while (this.index < this.cutscene.steps.length)
      this.execute(this.cutscene.steps[this.index]!, this.index++, now, true);
    this.host.settle();
    this.running = [];
    this.state = 'skipped';
    this.emit({ type: 'skipped', cutscene: this.cutscene.id });
  }

  /** Advance with the stage clock. Does nothing while paused. */
  update(now: number): void {
    if (this.pausedReasons.size || (this.state !== 'playing' && this.state !== 'awaiting-input'))
      return;
    for (let guard = 0; guard < 10_000; guard++) {
      const waiting = this.waiting;
      if (waiting) {
        if (waiting.kind === 'time') {
          if (now < waiting.until) return;
        } else if (waiting.kind === 'line') {
          const outcome = waiting.handle.outcome();
          if (outcome === 'pending') return;
          this.emit({ type: 'line-ended', index: waiting.index, line: waiting.line, outcome });
          // A line that could not be heard never auto-advances: the child reads the caption.
          if (waiting.advance === 'input' || outcome === 'failed') {
            this.waiting = { kind: 'input', index: waiting.index };
            this.state = 'awaiting-input';
            this.emit({ type: 'awaiting-input', index: waiting.index });
            return;
          }
        } else if (waiting.kind === 'input') return;
        else if (this.running.some((end) => end > now)) return;
        this.waiting = undefined;
      }
      this.running = this.running.filter((end) => end > now);
      if (this.index >= this.cutscene.steps.length) {
        if (this.running.length) {
          this.waiting = { kind: 'join' };
          continue;
        }
        this.state = 'completed';
        this.emit({ type: 'completed', cutscene: this.cutscene.id });
        return;
      }
      const index = this.index++;
      this.execute(this.cutscene.steps[index]!, index, now, false);
    }
  }

  private execute(raw: CutsceneStep, index: number, now: number, instant: boolean): void {
    const step = this.resolve(raw);
    const options = { instant };
    if (!instant) this.emit({ type: 'step', index, op: step.op });
    let duration = 0;
    switch (step.op) {
      case 'background':
        duration = this.host.background(
          step.asset,
          { type: step.transition?.type ?? 'cut', duration: step.transition?.duration ?? 0.6 },
          options,
        );
        break;
      case 'camera':
        duration = this.host.camera(
          step.preset ?? step.to!,
          {
            duration: step.duration ?? 1,
            ...(step.ease ? { ease: step.ease } : {}),
            cut: step.cut ?? false,
          },
          options,
        );
        break;
      case 'enter':
        duration = this.host.enter(
          step.actor,
          step.from,
          step.to,
          {
            ...(step.duration !== undefined ? { duration: step.duration } : {}),
            walk: step.walk ?? true,
            ...(step.ease ? { ease: step.ease } : {}),
          },
          options,
        );
        break;
      case 'exit':
        duration = this.host.exit(
          step.actor,
          step.to,
          {
            ...(step.duration !== undefined ? { duration: step.duration } : {}),
            walk: step.walk ?? true,
            ...(step.ease ? { ease: step.ease } : {}),
          },
          options,
        );
        break;
      case 'move':
        duration = this.host.move(
          step.actor,
          step.path ?? [step.to!],
          {
            ...(step.duration !== undefined ? { duration: step.duration } : {}),
            ...(step.speed !== undefined ? { speed: step.speed } : {}),
            walk: step.walk ?? true,
            ...(step.ease ? { ease: step.ease } : {}),
          },
          options,
        );
        break;
      case 'pose':
        duration = this.host.pose(
          step.actor,
          {
            ...(step.expression ? { expression: step.expression } : {}),
            ...(step.clip ? { clip: step.clip } : {}),
            ...(step.face ? { face: step.face } : {}),
          },
          options,
        );
        break;
      case 'emote':
        duration = this.host.emote(step.actor, step.emote, options);
        break;
      case 'line': {
        if (instant) break;
        const handle = this.host.line(step.actor, step.line);
        this.emit({
          type: 'line',
          index,
          line: step.line,
          ...(step.actor ? { actor: step.actor } : {}),
        });
        if (step.wait === false) return;
        this.waiting = {
          kind: 'line',
          handle,
          advance: step.advance ?? this.cutscene.advance ?? 'input',
          index,
          line: step.line,
        };
        return;
      }
      case 'music':
        this.host.music(step.asset, step.fade ?? 1, options);
        break;
      case 'atmosphere':
        this.host.atmosphere(step.asset, step.fade ?? 1, options);
        break;
      case 'sfx':
        if (!instant) this.host.sfx(step.asset, step.gain ?? 1);
        break;
      case 'effect':
        duration = this.host.effect(step.effect, step.at, step.duration ?? 1, options);
        break;
      case 'transition':
        duration = this.host.transition(
          step.type,
          step.duration ?? 0.6,
          step.color ?? '#000000',
          options,
        );
        break;
      case 'wait':
        if (instant) break;
        if (step.for === 'input') {
          this.waiting = { kind: 'input', index };
          this.state = 'awaiting-input';
          this.emit({ type: 'awaiting-input', index });
          return;
        }
        duration = step.seconds ?? 0;
        break;
      case 'marker':
        this.lastMarker = step.id;
        if (!instant) this.emit({ type: 'marker', id: step.id });
        return;
      case 'join':
        if (!instant && this.running.some((end) => end > now)) this.waiting = { kind: 'join' };
        return;
    }
    if (instant || !(duration > 0)) return;
    const blocking = step.wait ?? !NON_BLOCKING.has(step.op);
    if (blocking) this.waiting = { kind: 'time', until: now + duration };
    else this.running.push(now + duration);
  }
}
