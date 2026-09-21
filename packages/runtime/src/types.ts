import type { Prng, PrngState, WorldSnapshot } from '@aegis/core';
import type { ContentPack, ContentRegistration, DeepReadonly, JsonValue, Schema } from './data.js';
import type { Outcome, RuntimeError } from './outcome.js';

export type RandomStream = Pick<
  Prng,
  'nextUint32' | 'nextFloat' | 'range' | 'int' | 'bool' | 'pick'
>;
export type PauseReason = string;

export interface PhaseClock {
  id: string;
  instance: number;
  enteredTurn: number;
  allowance: number;
}

export type JobAnchor =
  | { readonly kind: 'elapsed'; readonly turn: number }
  | { readonly kind: 'phase-entry'; readonly instance: number; readonly offset: number }
  | { readonly kind: 'phase-end'; readonly instance: number; readonly offset: number };

export interface JobRequest {
  readonly id: string;
  readonly rule: string;
  readonly payload: JsonValue;
  readonly anchor: JobAnchor;
  readonly phase: string;
  readonly priority: number;
}

export interface ScheduledJob extends JobRequest {
  readonly token: number;
  readonly dueTurn: number;
}

export interface JobTicket {
  readonly id: string;
  readonly token: number;
}

export interface ActionPlan {
  readonly rule: string;
  readonly payload: JsonValue;
  readonly turns: number;
}

export interface PendingAction extends ActionPlan {
  readonly id: number;
  completedTurns: number;
  progress: JsonValue;
}

export interface RuntimeSnapshot {
  readonly format: 'aegis-runtime/1';
  readonly adapter: string;
  readonly stateVersion: number;
  readonly content: {
    readonly id: string;
    readonly revision: string;
    readonly schemaVersion: number;
    readonly hash: string;
  };
  readonly seed: string | number;
  readonly revision: number;
  readonly turn: number;
  readonly world: WorldSnapshot;
  readonly streams: Readonly<Record<string, PrngState>>;
  readonly pending: PendingAction | null;
  readonly jobs: readonly ScheduledJob[];
  readonly claims: readonly string[];
  readonly consumedJobs: readonly JobTicket[];
  readonly phase: PhaseClock | null;
  readonly nextAction: number;
  readonly nextJob: number;
  readonly nextPhase: number;
}

export interface RuntimeRead<S, C> {
  readonly state: DeepReadonly<S>;
  readonly content: DeepReadonly<ContentPack<C>>;
  readonly revision: number;
  readonly turn: number;
  readonly phase: DeepReadonly<PhaseClock> | null;
  readonly pending: DeepReadonly<PendingAction> | null;
  readonly jobs: DeepReadonly<readonly ScheduledJob[]>;
  readonly claims: readonly string[];
}

export interface ResolveContext<S, C> extends RuntimeRead<S, C> {
  random(stream?: string): RandomStream;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly data: JsonValue;
  readonly rule: string;
}

export interface TransitionContext<S, C> {
  state: S;
  readonly content: DeepReadonly<ContentPack<C>>;
  readonly turn: number;
  readonly revision: number;
  readonly phase: DeepReadonly<PhaseClock> | null;
  random(stream?: string): RandomStream;
  emit(type: string, data?: JsonValue): void;
  /** Returns false if this durable claim was already consumed. */
  claim(id: string): boolean;
  hasClaim(id: string): boolean;
  schedule(job: JobRequest, replace?: JobTicket): JobTicket;
  cancel(ticket: JobTicket): Outcome<void>;
  /** New phases require an explicit policy for any still-pending phase-anchored jobs. */
  enterPhase(id: string, allowance: number, pendingJobs: 'reject' | 'cancel'): void;
  /** Only phase-end anchors move; consumed events never return. Past-due movement is rejected. */
  adjustAllowance(allowance: number): void;
}

export interface CommandRule<S, C> {
  readonly id: string;
  readonly payload: Schema<JsonValue>;
  readonly progress: Schema<JsonValue>;
  start?(context: TransitionContext<S, C>, action: PendingAction): void;
  turn?(context: TransitionContext<S, C>, action: PendingAction): void;
  finish?(context: TransitionContext<S, C>, action: PendingAction): void;
}

export interface JobRule<S, C> {
  readonly id: string;
  readonly payload: Schema<JsonValue>;
  run(context: TransitionContext<S, C>, job: DeepReadonly<ScheduledJob>): void;
}

export interface InitializeContext<C> {
  readonly content: DeepReadonly<ContentPack<C>>;
  random(stream?: string): RandomStream;
}

export interface RuntimeAdapter<S, A, V, C> {
  readonly id: string;
  readonly stateVersion: number;
  readonly state: Schema<S>;
  readonly action: Schema<A>;
  readonly content: ContentRegistration<C>;
  readonly randomStreams?: readonly string[];
  readonly eventPhases: readonly string[];
  readonly commands: readonly CommandRule<S, C>[];
  readonly jobs?: readonly JobRule<S, C>[];
  initialize(context: InitializeContext<C>): S;
  resolve(action: A, context: ResolveContext<S, C>): Outcome<ActionPlan>;
  view(context: RuntimeRead<S, C>): V;
  /** Runs on creation, every commit, restore and content activation; check active references here. */
  validate?(context: RuntimeRead<S, C>): Outcome<void>;
  canActivateContent?(current: RuntimeRead<S, C>, candidate: DeepReadonly<ContentPack<C>>): boolean;
  activateContent?(context: TransitionContext<S, C>, previous: DeepReadonly<ContentPack<C>>): void;
}

export type CommitKind = 'action' | 'turn' | 'content';

export interface RuntimeCommit<V = unknown> {
  readonly revision: number;
  readonly turn: number;
  readonly hash: string;
  readonly kind: CommitKind;
  readonly actionId: number | null;
  readonly snapshot: RuntimeSnapshot;
  readonly view: V;
  /** Transient effects, never replayed on restore or checkpoint retry. */
  readonly events: readonly RuntimeEvent[];
}

export interface Checkpoint {
  readonly revision: number;
  readonly hash: string;
  readonly kind: CommitKind | 'restore';
  readonly snapshot: RuntimeSnapshot;
}

export type CheckpointWriter = (checkpoint: Checkpoint) => Promise<Outcome<void>>;

export interface RuntimeStatus {
  readonly revision: number;
  readonly turn: number;
  readonly durableRevision: number | null;
  readonly checkpoint: 'disabled' | 'idle' | 'pending' | 'failed';
  readonly checkpointRevision: number | null;
  readonly pendingAction: number | null;
  readonly pauseReasons: readonly PauseReason[];
  readonly busy: boolean;
  readonly disposed: boolean;
  readonly error: RuntimeError | null;
}

export interface DispatchReceipt {
  readonly accepted: true;
  readonly revision: number;
  readonly turn: number;
  readonly hash: string;
  readonly durable: boolean;
  readonly pending: boolean;
}

export type DispatchOutcome =
  | { readonly ok: true; readonly value: DispatchReceipt }
  | {
      readonly ok: false;
      readonly error: RuntimeError;
      readonly progress: {
        readonly accepted: boolean;
        readonly committedRevision: number | null;
        readonly durableRevision: number | null;
        readonly pendingAction: number | null;
      };
    };

export interface RuntimeLimits {
  readonly maxTurnsPerAction?: number;
  readonly maxEventsPerCommit?: number;
  readonly maxPendingJobs?: number;
  readonly maxAllowance?: number;
}

export interface RuntimeOptions<S, A, V, C> {
  readonly adapter: RuntimeAdapter<S, A, V, C>;
  readonly content: ContentPack<C>;
  readonly seed: string | number;
  readonly checkpoint?: CheckpointWriter;
  readonly limits?: RuntimeLimits;
  /** Edge-only preparation; gameplay is blocked and the candidate is not live until it succeeds. */
  readonly prepareRestore?: (
    snapshot: RuntimeSnapshot,
    content: DeepReadonly<ContentPack<C>>,
  ) => Promise<Outcome<void>>;
  /** Listener exceptions are isolated after commit and exposed here and in status.error. */
  readonly onError?: (error: RuntimeError) => void;
}

export interface RuntimeHost<S, A, V, C> {
  getView(): V;
  getStatus(): RuntimeStatus;
  inspect(): RuntimeRead<S, C>;
  hash(): string;
  snapshot(): RuntimeSnapshot;
  dispatch(action: A, options?: { expectedRevision?: number }): Promise<DispatchOutcome>;
  continuePending(): Promise<DispatchOutcome>;
  retryCheckpoint(): Promise<Outcome<void>>;
  flush(revision?: number): Promise<Outcome<{ revision: number }>>;
  subscribe(listener: (view: V, reason: 'commit' | 'restore') => void): () => void;
  subscribeCommits(listener: (commit: RuntimeCommit<V>) => void): () => void;
  subscribeStatus(listener: (status: RuntimeStatus) => void): () => void;
  pause(reason: PauseReason): void;
  resume(reason: PauseReason): void;
  restore(
    candidate: unknown,
    options?: { durableRevision?: number; pauseReasons?: readonly PauseReason[] },
  ): Promise<Outcome<void>>;
  stageContent(candidate: unknown, file?: string): Outcome<ContentPack<C>>;
  activateContent(
    candidate: ContentPack<C>,
    mode: 'boundary' | 'restart',
  ): Promise<DispatchOutcome>;
  dispose(): Promise<void>;
}
