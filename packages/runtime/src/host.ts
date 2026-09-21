import { createWorld, defineResource, prngFromState } from '@aegis/core';
import type { Prng, PrngState, World } from '@aegis/core';
import {
  checkJson,
  cloneData,
  dataHash,
  freezeData,
  identifierSchema,
  validateContent,
} from './data.js';
import type { ContentPack, Schema } from './data.js';
import { caughtFailure, failure, fault, requireValue, success } from './outcome.js';
import type { Outcome, RuntimeError } from './outcome.js';
import { runtimeSnapshotSchema } from './snapshot.js';
import type {
  ActionPlan,
  Checkpoint,
  CommandRule,
  CommitKind,
  DispatchOutcome,
  DispatchReceipt,
  JobAnchor,
  JobRule,
  JobTicket,
  PendingAction,
  PhaseClock,
  RandomStream,
  RuntimeAdapter,
  RuntimeCommit,
  RuntimeEvent,
  RuntimeHost,
  RuntimeOptions,
  RuntimeRead,
  RuntimeSnapshot,
  RuntimeStatus,
  ScheduledJob,
  TransitionContext,
} from './types.js';

const STATE = 'aegis.runtime.state';

interface Draft<S, C> {
  state: S;
  content: ContentPack<C>;
  world: World;
  streams: Map<string, Prng>;
  revision: number;
  turn: number;
  pending: PendingAction | null;
  jobs: ScheduledJob[];
  claims: Set<string>;
  consumedJobs: JobTicket[];
  phase: PhaseClock | null;
  nextAction: number;
  nextJob: number;
  nextPhase: number;
  events: RuntimeEvent[];
  cursor: ScheduledJob | null;
  processedJobs: number;
}

function integer(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    fault('invalid-counter', `Expected an integer in [0, ${max}], got ${value}.`);
  }
  return value;
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fault('duplicate-id', `${label} IDs must be unique.`);
  for (const value of values) requireValue(identifierSchema.parse(value));
}

function synchronous(call: () => unknown): void {
  const result = call();
  if (result !== null && typeof result === 'object' && 'then' in result) {
    fault('async-rule', 'Authoritative rules must be synchronous.');
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function exact<T>(schema: Schema<T>, value: unknown, path: string): void {
  const parsed = requireValue(schema.parse(value, path));
  if (dataHash(parsed) !== dataHash(value)) {
    fault(
      'migration-required',
      'Saved state and resolved parameters must validate without implicit normalization.',
      path,
    );
  }
}

function streamApi(generator: Prng): RandomStream {
  return Object.freeze({
    nextUint32: () => generator.nextUint32(),
    nextFloat: () => generator.nextFloat(),
    range: (min: number, max: number) => generator.range(min, max),
    int: (min: number, max: number) => generator.int(min, max),
    bool: (p?: number) => generator.bool(p),
    pick: <T>(items: readonly T[]) => generator.pick(items),
  });
}

export function createRuntimeHost<S, A, V, C>(
  options: RuntimeOptions<S, A, V, C>,
): RuntimeHost<S, A, V, C> {
  const adapter: RuntimeAdapter<S, A, V, C> = options.adapter;
  requireValue(identifierSchema.parse(adapter.id));
  integer(adapter.stateVersion);
  const maxTurns = integer(options.limits?.maxTurnsPerAction ?? 1_000, 100_000);
  const maxEvents = integer(options.limits?.maxEventsPerCommit ?? 1_000, 100_000);
  const maxJobs = integer(options.limits?.maxPendingJobs ?? 10_000, 100_000);
  const maxAllowance = integer(options.limits?.maxAllowance ?? 1_000_000);
  if (maxEvents === 0) fault('invalid-limit', 'maxEventsPerCommit must be positive.');
  const phases = [...adapter.eventPhases];
  if (phases.length === 0) fault('invalid-phase', 'At least one event phase is required.');
  unique(phases, 'Event phase');
  const streamIds = [...(adapter.randomStreams ?? [])].sort();
  unique(['main', ...streamIds], 'Random stream');
  unique(
    adapter.commands.map((rule) => rule.id),
    'Command rule',
  );
  unique(
    (adapter.jobs ?? []).map((rule) => rule.id),
    'Job rule',
  );
  const commands = new Map(adapter.commands.map((rule) => [rule.id, rule]));
  const jobRules = new Map((adapter.jobs ?? []).map((rule) => [rule.id, rule]));
  const stateResource = defineResource<S>(STATE, () =>
    fault('missing-state', 'State must be initialized explicitly.'),
  );
  const installed = new Map<string, ContentPack<C>>();
  const contentKey = (pack: { id: string; revision: string }): string =>
    `${pack.id}#${pack.revision}`;
  let active = requireValue(validateContent(options.content, adapter.content));
  installed.set(contentKey(active), cloneData(active));
  const pauses = new Set<string>();
  const views = new Set<(view: V, reason: 'commit' | 'restore') => void>();
  const commits = new Set<(commit: RuntimeCommit<V>) => void>();
  const statuses = new Set<(status: RuntimeStatus) => void>();
  let disposed = false;
  let busy = false;
  let notifying = false;
  let ownership = 0;
  let durableRevision: number | null = null;
  let blocked: Checkpoint | null = null;
  let checkpointState: RuntimeStatus['checkpoint'] = options.checkpoint ? 'idle' : 'disabled';
  let lastError: RuntimeError | null = null;
  let writing: Promise<Outcome<void>> | null = null;

  function random(draft: Draft<S, C>, name = 'main'): RandomStream {
    const generator = name === 'main' ? draft.world.random : draft.streams.get(name);
    if (generator === undefined)
      fault('unknown-stream', `Random stream "${name}" is not registered.`);
    return streamApi(generator);
  }

  function read(draft: Draft<S, C>): RuntimeRead<S, C> {
    return {
      state: freezeData(cloneData(draft.state)),
      content: freezeData(cloneData(draft.content)),
      revision: draft.revision,
      turn: draft.turn,
      phase: freezeData(cloneData(draft.phase)),
      pending: freezeData(cloneData(draft.pending)),
      jobs: freezeData(cloneData(draft.jobs)),
      claims: Object.freeze([...draft.claims].sort()),
    };
  }

  function fresh(content: ContentPack<C>, seed: string | number = options.seed): Draft<S, C> {
    const world = createWorld({ seed });
    const streams = new Map(streamIds.map((id) => [id, world.random.fork(id)]));
    const initialRandom = (name = 'main'): RandomStream => {
      const generator = name === 'main' ? world.random : streams.get(name);
      if (generator === undefined)
        fault('unknown-stream', `Random stream "${name}" is not registered.`);
      return streamApi(generator);
    };
    const state = cloneData(
      adapter.initialize({
        content: freezeData(cloneData(content)),
        random: initialRandom,
      }),
    );
    return {
      state,
      content,
      world,
      streams,
      revision: 0,
      turn: 0,
      pending: null,
      jobs: [],
      claims: new Set(),
      consumedJobs: [],
      phase: null,
      nextAction: 1,
      nextJob: 1,
      nextPhase: 1,
      events: [],
      cursor: null,
      processedJobs: 0,
    };
  }

  function order(a: ScheduledJob, b: ScheduledJob): number {
    return (
      a.dueTurn - b.dueTurn ||
      phases.indexOf(a.phase) - phases.indexOf(b.phase) ||
      a.priority - b.priority ||
      compareText(a.id, b.id) ||
      a.token - b.token
    );
  }

  function due(anchor: JobAnchor, phase: PhaseClock | null): number {
    if (anchor.kind === 'elapsed') return integer(anchor.turn);
    if (phase === null || phase.instance !== anchor.instance) {
      fault('stale-phase', 'A phase anchor must name the current phase instance.');
    }
    if (
      !Number.isSafeInteger(anchor.offset) ||
      (anchor.kind === 'phase-entry' && anchor.offset < 0)
    ) {
      fault('invalid-anchor', 'Invalid phase event offset.');
    }
    return integer(
      phase.enteredTurn + anchor.offset + (anchor.kind === 'phase-end' ? phase.allowance : 0),
    );
  }

  function command(id: string): CommandRule<S, C> {
    const result = commands.get(id);
    if (result === undefined) fault('unknown-rule', `Command rule "${id}" is not registered.`);
    return result;
  }

  function jobRule(id: string): JobRule<S, C> {
    const result = jobRules.get(id);
    if (result === undefined) fault('unknown-rule', `Job rule "${id}" is not registered.`);
    return result;
  }

  function validate(draft: Draft<S, C>): void {
    requireValue(checkJson(draft.state));
    exact(adapter.state, draft.state, 'state');
    integer(draft.turn);
    integer(draft.revision);
    integer(draft.nextAction);
    integer(draft.nextJob);
    integer(draft.nextPhase);
    if (
      draft.revision < draft.turn ||
      draft.nextAction < 1 ||
      draft.nextAction > draft.revision + 1 ||
      draft.nextJob < 1 ||
      draft.nextPhase < 1
    ) {
      fault('invalid-counter', 'Snapshot revision and identity counters are inconsistent.');
    }
    unique([...draft.claims], 'Claim');
    if (draft.phase !== null) {
      requireValue(identifierSchema.parse(draft.phase.id));
      integer(draft.phase.allowance, maxAllowance);
      if (
        draft.phase.enteredTurn > draft.turn ||
        draft.phase.instance < 1 ||
        draft.phase.instance >= draft.nextPhase
      ) {
        fault('invalid-phase', 'Phase identity or entry turn is inconsistent.');
      }
    }
    if (draft.pending !== null) {
      const action = draft.pending;
      integer(action.turns, maxTurns);
      if (
        action.id < 1 ||
        action.id !== draft.nextAction - 1 ||
        action.completedTurns < 1 ||
        action.completedTurns >= action.turns ||
        action.completedTurns > draft.turn
      ) {
        fault('invalid-pending', 'Saved pending action has inconsistent identity or progress.');
      }
      exact(command(action.rule).payload, action.payload, 'pending.payload');
      exact(command(action.rule).progress, action.progress, 'pending.progress');
    }
    if (draft.jobs.length > maxJobs) fault('job-limit', 'Too many pending jobs.');
    unique(
      draft.jobs.map((job) => job.id),
      'Pending job',
    );
    const tokens = new Set<number>();
    for (const job of draft.jobs) {
      if (!phases.includes(job.phase))
        fault('invalid-phase', `Unknown event phase "${job.phase}".`);
      if (job.token < 1 || job.token >= draft.nextJob || tokens.has(job.token)) {
        fault('invalid-job', 'Job token must be unique and less than nextJob.');
      }
      tokens.add(job.token);
      if (due(job.anchor, draft.phase) !== job.dueTurn || job.dueTurn <= draft.turn) {
        fault(
          'invalid-job',
          'Job due turn does not match its anchor or was not processed at its committed boundary.',
        );
      }
      exact(jobRule(job.rule).payload, job.payload, `jobs.${job.id}.payload`);
    }
    for (const ticket of draft.consumedJobs) {
      if (ticket.token < 1 || ticket.token >= draft.nextJob || tokens.has(ticket.token)) {
        fault('invalid-job', 'Consumed and pending job tokens must be unique.');
      }
      tokens.add(ticket.token);
    }
    if (adapter.validate) requireValue(adapter.validate(read(draft)));
  }

  function capture(draft: Draft<S, C>, seed: string | number): RuntimeSnapshot {
    validate(draft);
    draft.world.setResource(stateResource, draft.state);
    const streams: Record<string, PrngState> = {};
    for (const [id, generator] of draft.streams) {
      Object.defineProperty(streams, id, { value: generator.save(), enumerable: true });
    }
    const snapshot: RuntimeSnapshot = {
      format: 'aegis-runtime/1',
      adapter: adapter.id,
      stateVersion: adapter.stateVersion,
      content: {
        id: draft.content.id,
        revision: draft.content.revision,
        schemaVersion: draft.content.schemaVersion,
        hash: dataHash(draft.content),
      },
      seed,
      revision: draft.revision,
      turn: draft.turn,
      world: draft.world.snapshot(),
      streams,
      pending: draft.pending,
      jobs: [...draft.jobs].sort(order),
      claims: [...draft.claims].sort(),
      consumedJobs: draft.consumedJobs,
      phase: draft.phase,
      nextAction: draft.nextAction,
      nextJob: draft.nextJob,
      nextPhase: draft.nextPhase,
    };
    return cloneData(requireValue(runtimeSnapshotSchema.parse(cloneData(snapshot))));
  }

  function stage(snapshot: RuntimeSnapshot, content: ContentPack<C>): Draft<S, C> {
    const world = createWorld({ seed: snapshot.seed });
    world.restore(snapshot.world);
    const state = world.getResource(stateResource);
    if (state === undefined)
      fault('missing-state', 'Snapshot does not contain the registered state.');
    if (Object.keys(snapshot.streams).sort().join('|') !== streamIds.join('|')) {
      fault('incompatible-save', 'Saved PRNG stream registrations differ.');
    }
    const draft: Draft<S, C> = {
      state,
      content,
      world,
      streams: new Map(
        Object.entries(snapshot.streams).map(([id, saved]) => [id, prngFromState(saved)]),
      ),
      revision: snapshot.revision,
      turn: snapshot.turn,
      pending: cloneData(snapshot.pending),
      jobs: cloneData([...snapshot.jobs]),
      claims: new Set(snapshot.claims),
      consumedJobs: cloneData([...snapshot.consumedJobs]),
      phase: cloneData(snapshot.phase),
      nextAction: snapshot.nextAction,
      nextJob: snapshot.nextJob,
      nextPhase: snapshot.nextPhase,
      events: [],
      cursor: null,
      processedJobs: 0,
    };
    unique(snapshot.claims, 'Claim');
    validate(draft);
    return draft;
  }

  let current = capture(fresh(active), options.seed);
  let currentView = cloneData(adapter.view(read(stage(current, active))));

  function status(): RuntimeStatus {
    return {
      revision: current.revision,
      turn: current.turn,
      durableRevision,
      checkpoint: checkpointState,
      checkpointRevision: blocked?.revision ?? null,
      pendingAction: current.pending?.id ?? null,
      pauseReasons: [...pauses].sort(),
      busy,
      disposed,
      error: lastError === null ? null : cloneData(lastError),
    };
  }

  function report(error: RuntimeError): void {
    lastError = cloneData(error);
    if (options.onError) {
      try {
        options.onError(cloneData(error));
      } catch (callbackError) {
        const failed = caughtFailure(callbackError, 'error-listener-failed');
        if (!failed.ok) lastError = failed.error;
      }
    }
  }

  function notify<T>(listeners: Set<(value: T) => void>, value: T): void {
    const previous = notifying;
    notifying = true;
    try {
      for (const listener of [...listeners]) {
        if (disposed) break;
        if (!listeners.has(listener)) continue;
        try {
          listener(cloneData(value));
        } catch (error) {
          const failed = caughtFailure(error, 'listener-failed');
          if (!failed.ok) report(failed.error);
        }
      }
    } finally {
      notifying = previous;
    }
  }

  function notifyView(reason: 'commit' | 'restore'): void {
    const previous = notifying;
    notifying = true;
    try {
      for (const listener of [...views]) {
        if (disposed) break;
        if (!views.has(listener)) continue;
        try {
          listener(cloneData(currentView), reason);
        } catch (error) {
          const failed = caughtFailure(error, 'listener-failed');
          if (!failed.ok) report(failed.error);
        }
      }
    } finally {
      notifying = previous;
    }
  }

  function announce(): void {
    // Status listeners may add/remove pause reasons. Do not recursively notify them.
    if (!notifying) notify(statuses, status());
  }

  function context(draft: Draft<S, C>, rule: string): TransitionContext<S, C> {
    return {
      get state() {
        return draft.state;
      },
      set state(value: S) {
        draft.state = value;
      },
      content: freezeData(cloneData(draft.content)),
      get turn() {
        return draft.turn;
      },
      get revision() {
        return draft.revision;
      },
      get phase() {
        return freezeData(cloneData(draft.phase));
      },
      random: (name) => random(draft, name),
      emit(type, data = null) {
        requireValue(identifierSchema.parse(type));
        if (draft.events.length >= maxEvents)
          fault('transition-limit', 'Too many emitted events in one commit.');
        draft.events.push({ type, data: cloneData(data), rule });
      },
      hasClaim: (id) => draft.claims.has(id),
      claim(id) {
        requireValue(identifierSchema.parse(id));
        if (draft.claims.has(id)) return false;
        draft.claims.add(id);
        return true;
      },
      schedule(request, replacement) {
        requireValue(checkJson(request));
        requireValue(identifierSchema.parse(request.id));
        if (!phases.includes(request.phase))
          fault('invalid-phase', `Unknown event phase "${request.phase}".`);
        if (!Number.isSafeInteger(request.priority))
          fault('invalid-priority', 'Job priority must be a safe integer.');
        exact(jobRule(request.rule).payload, request.payload, 'job.payload');
        const prior = draft.jobs.find((job) => job.id === request.id);
        if (
          replacement !== undefined &&
          (replacement.id !== request.id || prior?.token !== replacement.token)
        ) {
          fault('stale-job', 'Replacement ticket is stale.');
        }
        if (prior !== undefined && replacement === undefined)
          fault('duplicate-job', 'Use an exact ticket to replace an existing job.');
        if (prior === undefined && replacement !== undefined)
          fault('stale-job', 'Cannot replace a job that no longer exists.');
        const job: ScheduledJob = {
          ...cloneData(request),
          token: integer(draft.nextJob),
          dueTurn: due(request.anchor, draft.phase),
        };
        if (job.dueTurn < draft.turn) fault('past-job', 'Cannot schedule work in the past.');
        if (draft.cursor !== null && order(job, draft.cursor) <= 0) {
          fault('event-order', 'New same-turn work cannot precede the currently executing job.');
        }
        draft.nextJob = integer(draft.nextJob + 1);
        if (prior !== undefined) draft.jobs = draft.jobs.filter((entry) => entry !== prior);
        draft.jobs.push(job);
        if (draft.jobs.length > maxJobs) fault('job-limit', 'Too many pending jobs.');
        return { id: job.id, token: job.token };
      },
      cancel(ticket) {
        const prior = draft.jobs.find((job) => job.id === ticket.id && job.token === ticket.token);
        if (!prior) return failure('stale-job', 'Job ticket is stale or already completed.');
        draft.jobs = draft.jobs.filter((job) => job !== prior);
        return success(undefined);
      },
      enterPhase(id, allowance, pendingJobs) {
        requireValue(identifierSchema.parse(id));
        integer(allowance, maxAllowance);
        if (pendingJobs !== 'reject' && pendingJobs !== 'cancel')
          fault('invalid-policy', 'Declare how phase jobs are handled.');
        const anchored = draft.jobs.filter((job) => job.anchor.kind !== 'elapsed');
        if (anchored.length > 0 && pendingJobs === 'reject')
          fault('pending-phase-jobs', 'Current phase still has pending anchored jobs.');
        if (pendingJobs === 'cancel')
          draft.jobs = draft.jobs.filter((job) => job.anchor.kind === 'elapsed');
        draft.phase = { id, instance: draft.nextPhase, enteredTurn: draft.turn, allowance };
        draft.nextPhase = integer(draft.nextPhase + 1);
      },
      adjustAllowance(allowance) {
        if (draft.phase === null)
          fault('missing-phase', 'Enter a phase before adjusting its allowance.');
        integer(allowance, maxAllowance);
        const candidate = { ...draft.phase, allowance };
        const jobs = draft.jobs.map((job) => {
          if (job.anchor.kind !== 'phase-end') return job;
          const dueTurn = due(job.anchor, candidate);
          if (dueTurn < draft.turn)
            fault('past-job', 'Allowance change would move a pending event into the past.');
          return { ...job, dueTurn };
        });
        draft.phase = candidate;
        draft.jobs = jobs;
      },
    };
  }

  function drain(draft: Draft<S, C>): void {
    while (true) {
      draft.jobs.sort(order);
      const job = draft.jobs[0];
      if (job === undefined || job.dueTurn > draft.turn) break;
      if (++draft.processedJobs > maxEvents)
        fault('transition-limit', 'Automatic event chain exceeded its bound.');
      if (draft.cursor !== null && order(job, draft.cursor) <= 0)
        fault('event-order', 'An event moved behind the resolution cursor.');
      draft.jobs.shift();
      draft.cursor = job;
      const rule = jobRule(job.rule);
      synchronous(() => rule.run(context(draft, rule.id), freezeData(cloneData(job))));
      draft.consumedJobs.push({ id: job.id, token: job.token });
    }
    draft.cursor = null;
  }

  function execute(draft: Draft<S, C>, phase: 'start' | 'turn' | 'finish'): void {
    const pending = draft.pending;
    if (pending === null) fault('missing-action', 'No action is pending.');
    const rule = command(pending.rule);
    const input = cloneData(pending);
    freezeData<unknown>(input.payload);
    synchronous(() => rule[phase]?.(context(draft, rule.id), input));
    exact(rule.progress, input.progress, 'pending.progress');
    // Only explicit progress is mutable; resolved parameters and counters remain engine-owned.
    pending.progress = cloneData(input.progress);
  }

  function advance(draft: Draft<S, C>, starting: boolean): void {
    const pending = draft.pending;
    if (pending === null) fault('missing-action', 'No action is pending.');
    if (starting) {
      execute(draft, 'start');
      drain(draft);
    }
    if (pending.turns > 0) {
      draft.turn = integer(draft.turn + 1);
      pending.completedTurns++;
      execute(draft, 'turn');
      drain(draft);
    }
    if (pending.completedTurns === pending.turns) {
      execute(draft, 'finish');
      drain(draft);
      draft.pending = null;
    }
    draft.revision = integer(draft.revision + 1);
  }

  function publish(draft: Draft<S, C>, kind: CommitKind, actionId: number | null): void {
    if (disposed) fault('disposed', 'Runtime was disposed before the draft committed.');
    const snapshot = capture(draft, current.seed);
    const projected = cloneData(adapter.view(read(draft)));
    // All fallible rule/schema/projection work precedes this replacement.
    current = snapshot;
    active = cloneData(draft.content);
    currentView = projected;
    const hash = dataHash(current);
    if (options.checkpoint) {
      blocked = { revision: current.revision, hash, kind, snapshot: cloneData(current) };
      checkpointState = 'pending';
    }
    notifyView('commit');
    notify(commits, {
      revision: current.revision,
      turn: current.turn,
      hash,
      kind,
      actionId,
      snapshot: current,
      view: currentView,
      events: draft.events,
    });
    announce();
  }

  async function acknowledge(): Promise<Outcome<void>> {
    if (disposed) return failure('disposed', 'Runtime was disposed before checkpoint IO began.');
    if (blocked === null) return success(undefined);
    if (writing !== null) return writing;
    const checkpoint = cloneData(blocked);
    freezeData<unknown>(checkpoint);
    const own = ownership;
    const writer = options.checkpoint;
    if (writer === undefined)
      return failure('checkpoint-unavailable', 'No checkpoint writer is configured.');
    checkpointState = 'pending';
    lastError = null;
    announce();
    const operation = (async (): Promise<Outcome<void>> => {
      let result: Outcome<void>;
      try {
        result = await writer(checkpoint);
      } catch (error) {
        result = caughtFailure(error, 'checkpoint-failed');
      }
      if (own !== ownership || disposed)
        return failure('superseded', 'Checkpoint belongs to a replaced or disposed session.');
      if (!result.ok) {
        checkpointState = 'failed';
        report(result.error);
      } else {
        durableRevision = checkpoint.revision;
        blocked = null;
        checkpointState = 'idle';
      }
      announce();
      return result;
    })();
    writing = operation;
    try {
      return await operation;
    } finally {
      if (writing === operation) writing = null;
    }
  }

  function receipt(): Outcome<DispatchReceipt> {
    return success({
      accepted: true,
      revision: current.revision,
      turn: current.turn,
      hash: dataHash(current),
      durable: durableRevision === current.revision,
      pending: current.pending !== null,
    });
  }

  function unavailable(allowPending = false, allowPause = false): Outcome<never> | null {
    if (disposed) return failure('disposed', 'Runtime is disposed.');
    if (busy || notifying)
      return failure(
        'busy',
        'Another operation or notification is active; commands are not queued.',
      );
    if (blocked !== null)
      return failure(
        'checkpoint-blocked',
        'The committed checkpoint needs acknowledgement or explicit recovery.',
      );
    if (!allowPause && pauses.size > 0) return failure('paused', 'Gameplay is paused.');
    if (!allowPending && current.pending !== null)
      return failure(
        'action-pending',
        'Continue the saved action before submitting another command.',
      );
    return null;
  }

  async function finishTurns(
    own: number,
    onCommit: (revision: number) => void = () => {},
  ): Promise<Outcome<DispatchReceipt>> {
    const saved = await acknowledge();
    if (!saved.ok) return saved;
    if (own !== ownership || disposed)
      return failure('superseded', 'Runtime operation was replaced or disposed.');
    while (current.pending !== null) {
      if (pauses.size > 0) return receipt();
      const draft = stage(current, active);
      const id = draft.pending?.id ?? null;
      advance(draft, false);
      publish(draft, 'turn', id);
      onCommit(current.revision);
      const savedTurn = await acknowledge();
      if (!savedTurn.ok) return savedTurn;
      if (own !== ownership || disposed)
        return failure('superseded', 'Runtime operation was replaced or disposed.');
    }
    return receipt();
  }

  async function operation<T>(run: (own: number) => Promise<Outcome<T>>): Promise<Outcome<T>> {
    busy = true;
    const own = ownership;
    announce();
    try {
      if (disposed || own !== ownership)
        return failure('superseded', 'Operation was cancelled before it began.');
      return await run(own);
    } catch (error) {
      const result = caughtFailure(error, 'transition-failed');
      if (!result.ok && own === ownership && !disposed) report(result.error);
      return result;
    } finally {
      if (own === ownership) {
        busy = false;
        announce();
      }
    }
  }

  function subscribe<T>(set: Set<T>, listener: T): () => void {
    if (disposed) fault('disposed', 'Cannot subscribe to a disposed runtime.');
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  function dispatchResult(
    result: Outcome<DispatchReceipt>,
    committedRevision: number | null = null,
  ): DispatchOutcome {
    return result.ok
      ? result
      : {
          ...result,
          progress: {
            accepted: committedRevision !== null,
            committedRevision,
            durableRevision,
            pendingAction: current.pending?.id ?? null,
          },
        };
  }

  return {
    getView: () => cloneData(currentView),
    getStatus: status,
    inspect: () => read(stage(current, active)),
    hash: () => dataHash(current),
    snapshot: () => cloneData(current),
    subscribe: (listener) => subscribe(views, listener),
    subscribeCommits: (listener) => subscribe(commits, listener),
    subscribeStatus: (listener) => subscribe(statuses, listener),
    pause(reason) {
      if (disposed) fault('disposed', 'Runtime is disposed.');
      requireValue(identifierSchema.parse(reason));
      pauses.add(reason);
      announce();
    },
    resume(reason) {
      if (disposed) fault('disposed', 'Runtime is disposed.');
      pauses.delete(reason);
      announce();
    },
    async dispatch(action, request = {}) {
      const rejected = unavailable();
      if (rejected) return dispatchResult(rejected);
      if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
        return dispatchResult(
          failure('stale-action', 'Command was authored against a different committed revision.'),
        );
      }
      let committed: number | null = null;
      const result = await operation(async (own) => {
        if (pauses.size > 0) return failure('paused', 'Gameplay paused before the command began.');
        requireValue(checkJson(action));
        const parsed = requireValue(adapter.action.parse(cloneData(action), 'action'));
        const draft = stage(current, active);
        const plan: ActionPlan = cloneData(
          requireValue(
            adapter.resolve(parsed, {
              ...read(draft),
              random: (name) => random(draft, name),
            }),
          ),
        );
        integer(plan.turns, maxTurns);
        exact(command(plan.rule).payload, plan.payload, 'plan.payload');
        draft.pending = { ...plan, id: draft.nextAction, completedTurns: 0, progress: null };
        draft.nextAction = integer(draft.nextAction + 1);
        const id = draft.pending.id;
        advance(draft, true);
        publish(draft, plan.turns === 0 ? 'action' : 'turn', id);
        committed = current.revision;
        return finishTurns(own, (revision) => {
          committed = revision;
        });
      });
      return dispatchResult(result, committed);
    },
    async continuePending() {
      const rejected = unavailable(true);
      if (rejected) return dispatchResult(rejected);
      if (current.pending === null)
        return dispatchResult(failure('no-pending-action', 'There is no action to continue.'));
      let committed: number | null = null;
      const result = await operation((own) =>
        finishTurns(own, (revision) => {
          committed = revision;
        }),
      );
      return dispatchResult(result, committed);
    },
    async retryCheckpoint() {
      if (disposed) return failure('disposed', 'Runtime is disposed.');
      if (busy || notifying) return failure('busy', 'Another operation is active.');
      if (blocked === null)
        return failure('no-checkpoint', 'There is no failed or pending checkpoint to retry.');
      return operation(() => acknowledge());
    },
    async flush(revision = current.revision) {
      if (disposed) return failure('disposed', 'Runtime is disposed.');
      if (!options.checkpoint)
        return failure('checkpoint-unavailable', 'No checkpoint writer is configured.');
      if (!Number.isSafeInteger(revision) || revision < 0 || revision > current.revision) {
        return failure('invalid-revision', 'Requested checkpoint revision does not exist.');
      }
      if (durableRevision !== null && durableRevision >= revision) return success({ revision });
      if (writing !== null) {
        const result = await writing;
        if (!result.ok) return result;
        if (durableRevision !== null && durableRevision >= revision) return success({ revision });
      }
      return failure(
        'checkpoint-pending',
        'The requested revision is not durably acknowledged; retry explicitly.',
      );
    },
    async restore(candidate, restoreOptions = {}) {
      if (disposed) return failure('disposed', 'Runtime is disposed.');
      // Restore is explicit recovery and may supersede an outstanding failed/pending write.
      if (notifying || (busy && writing === null))
        return failure(
          'busy',
          'Restore is not permitted during synchronous rules or listener delivery.',
        );
      const own = ++ownership;
      busy = true;
      writing = null;
      announce();
      try {
        requireValue(checkJson(candidate));
        const snapshot = cloneData(requireValue(runtimeSnapshotSchema.parse(candidate)));
        if (snapshot.adapter !== adapter.id || snapshot.stateVersion !== adapter.stateVersion) {
          return failure(
            'incompatible-save',
            'Adapter/state schema does not match; an explicit migration is required.',
          );
        }
        const content = installed.get(contentKey(snapshot.content));
        if (
          content === undefined ||
          dataHash(content) !== snapshot.content.hash ||
          content.schemaVersion !== snapshot.content.schemaVersion
        ) {
          return failure('incompatible-save', 'The exact saved content revision is not installed.');
        }
        const draft = stage(snapshot, content);
        const projected = cloneData(adapter.view(read(draft)));
        if (
          restoreOptions.durableRevision !== undefined &&
          restoreOptions.durableRevision !== snapshot.revision
        ) {
          return failure(
            'invalid-revision',
            'Restored durability must acknowledge the exact candidate revision.',
          );
        }
        const nextPauses =
          restoreOptions.pauseReasons === undefined ? undefined : [...restoreOptions.pauseReasons];
        if (nextPauses !== undefined) unique(nextPauses, 'Pause reason');
        if (options.prepareRestore) {
          requireValue(
            await options.prepareRestore(cloneData(snapshot), freezeData(cloneData(content))),
          );
        }
        if (own !== ownership || disposed)
          return failure('superseded', 'Restore was superseded or disposed.');
        current = snapshot;
        active = cloneData(content);
        currentView = projected;
        durableRevision = restoreOptions.durableRevision ?? null;
        if (nextPauses !== undefined) {
          pauses.clear();
          for (const reason of nextPauses) pauses.add(reason);
        }
        lastError = null;
        blocked =
          options.checkpoint && durableRevision !== snapshot.revision
            ? {
                revision: snapshot.revision,
                hash: dataHash(snapshot),
                kind: 'restore',
                snapshot: cloneData(snapshot),
              }
            : null;
        checkpointState = options.checkpoint ? (blocked === null ? 'idle' : 'pending') : 'disabled';
        notifyView('restore');
        return success(undefined);
      } catch (error) {
        const failed = caughtFailure(error, 'restore-failed');
        if (!failed.ok && own === ownership && !disposed) report(failed.error);
        return failed;
      } finally {
        if (own === ownership) {
          busy = false;
          announce();
        }
      }
    },
    stageContent(candidate, file) {
      if (disposed) return failure('disposed', 'Runtime is disposed.');
      try {
        const parsed = validateContent(candidate, adapter.content, file);
        if (!parsed.ok) return parsed;
        const prior = installed.get(contentKey(parsed.value));
        if (prior !== undefined && dataHash(prior) !== dataHash(parsed.value)) {
          return failure(
            'content-revision-reused',
            'Changed content needs a new revision identifier.',
          );
        }
        installed.set(contentKey(parsed.value), cloneData(parsed.value));
        return success(cloneData(parsed.value));
      } catch (error) {
        return caughtFailure(error, 'invalid-content');
      }
    },
    async activateContent(candidate, mode) {
      const rejected = unavailable(false, true);
      if (rejected) return dispatchResult(rejected);
      let committed: number | null = null;
      const result = await operation(async (own) => {
        const content = requireValue(validateContent(candidate, adapter.content));
        const installedContent = installed.get(contentKey(content));
        if (installedContent === undefined || dataHash(installedContent) !== dataHash(content)) {
          return failure('unstaged-content', 'Stage the complete candidate before activation.');
        }
        const previous = cloneData(active);
        let draft: Draft<S, C>;
        if (mode === 'restart') {
          draft = fresh(content, current.seed);
        } else if (mode === 'boundary') {
          draft = stage(current, active);
          if (!adapter.canActivateContent?.(read(draft), freezeData(cloneData(content)))) {
            return failure(
              'unsafe-boundary',
              'Consumer has not approved this content activation boundary.',
            );
          }
          if (draft.jobs.length > 0)
            return failure(
              'pending-jobs',
              'Resolve or cancel old jobs before activating different rules.',
            );
          draft.content = cloneData(content);
          synchronous(() =>
            adapter.activateContent?.(context(draft, 'content.activate'), freezeData(previous)),
          );
          drain(draft);
        } else return failure('invalid-policy', 'Content activation requires boundary or restart.');
        draft.revision = integer(current.revision + 1);
        publish(draft, 'content', null);
        committed = current.revision;
        return finishTurns(own);
      });
      return dispatchResult(result, committed);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      ownership++;
      busy = false;
      writing = null;
      views.clear();
      commits.clear();
      statuses.clear();
    },
  };
}
