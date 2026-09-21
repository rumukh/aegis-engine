import { cloneData } from './data.js';
import { caughtFailure, failure } from './outcome.js';
import type { Outcome, RuntimeError } from './outcome.js';
import type { RuntimeHost, RuntimeRead } from './types.js';

export interface TraceStep<A, S, V, C> {
  readonly action: A;
  readonly ruleIds: readonly string[];
  readonly expectError?: string;
  readonly expectedTurn?: number;
  readonly expectedRevision?: number;
  readonly expectedHash?: string;
  readonly assert?: (view: V, state: RuntimeRead<S, C>) => Outcome<void>;
}

export interface TraceFailure<A> {
  readonly seed: string | number;
  readonly contentRevision: string;
  readonly index: number;
  readonly action: A | null;
  readonly turn: number;
  readonly revision: number;
  readonly ruleIds: readonly string[];
  readonly error: RuntimeError;
}

export interface CommandTrace<A> {
  readonly passed: boolean;
  readonly checked: number;
  readonly commits: readonly {
    revision: number;
    turn: number;
    hash: string;
    events: readonly string[];
  }[];
  readonly failure: TraceFailure<A> | null;
}

/** Development-only report data: never logs or exposes a global inspector. */
export async function runCommandTrace<S, A, V, C>(
  host: RuntimeHost<S, A, V, C>,
  steps: readonly TraceStep<A, S, V, C>[],
): Promise<CommandTrace<A>> {
  if (steps.length === 0 || steps.length > 10_000) {
    const snapshot = host.snapshot();
    return {
      passed: false,
      checked: 0,
      commits: [],
      failure: {
        seed: snapshot.seed,
        contentRevision: snapshot.content.revision,
        index: 0,
        action: null,
        turn: snapshot.turn,
        revision: snapshot.revision,
        ruleIds: [],
        error: failure('trace-size', 'A command trace needs between 1 and 10,000 steps.').error,
      },
    };
  }
  const commits: { revision: number; turn: number; hash: string; events: readonly string[] }[] = [];
  const unsubscribe = host.subscribeCommits((commit) => {
    commits.push({
      revision: commit.revision,
      turn: commit.turn,
      hash: commit.hash,
      events: commit.events.map((event) => event.type),
    });
  });
  let checked = 0;
  try {
    for (const [index, step] of steps.entries()) {
      const outcome = await host.dispatch(step.action);
      let problem: Outcome<void> | undefined;
      const actualError = outcome.ok ? undefined : outcome.error.code;
      if (actualError !== step.expectError) {
        problem = failure(
          'trace-outcome',
          `Expected ${step.expectError ?? 'acceptance'}, got ${actualError ?? 'acceptance'}.`,
        );
      }
      checked++;
      const snapshot = host.snapshot();
      if (step.expectedTurn !== undefined) {
        checked++;
        if (snapshot.turn !== step.expectedTurn)
          problem = failure(
            'trace-turn',
            `Expected turn ${step.expectedTurn}, got ${snapshot.turn}.`,
          );
      }
      if (step.expectedRevision !== undefined) {
        checked++;
        if (snapshot.revision !== step.expectedRevision)
          problem = failure(
            'trace-revision',
            `Expected revision ${step.expectedRevision}, got ${snapshot.revision}.`,
          );
      }
      if (step.expectedHash !== undefined) {
        checked++;
        if (host.hash() !== step.expectedHash)
          problem = failure(
            'trace-hash',
            `Expected hash ${step.expectedHash}, got ${host.hash()}.`,
          );
      }
      if (step.assert) {
        checked++;
        try {
          const assertion = step.assert(host.getView(), host.inspect());
          if (!assertion.ok) problem = assertion;
        } catch (error) {
          problem = caughtFailure(error, 'trace-assertion');
        }
      }
      if (problem !== undefined && !problem.ok) {
        return {
          passed: false,
          checked,
          commits,
          failure: {
            seed: snapshot.seed,
            contentRevision: snapshot.content.revision,
            index,
            action: cloneData(step.action),
            turn: snapshot.turn,
            revision: snapshot.revision,
            ruleIds: [...step.ruleIds],
            error: problem.error,
          },
        };
      }
    }
    return { passed: true, checked, commits, failure: null };
  } finally {
    unsubscribe();
  }
}
