/** Test-only, failure-only observations. This function is also serialized into the browser. */
export function projectHorrorFailure(input: {
  snapshot: unknown;
  events?: unknown;
  observations?: unknown;
}): Record<string, unknown> {
  const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const record = (value: unknown): Record<string, unknown> => (object(value) ? value : {});
  let valueNodes = 0;
  let textChars = 0;
  let truncated = false;
  const bounded = (value: unknown, depth = 0): unknown => {
    if (++valueNodes > 512) {
      truncated = true;
      return '[value budget]';
    }
    if (value === undefined) return null;
    if (typeof value === 'string') {
      const count = Math.min(value.length, 240, Math.max(0, 8192 - textChars));
      textChars += count;
      if (count < value.length) truncated = true;
      return count < value.length ? `${value.slice(0, count)}...[truncated]` : value;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (value === null || typeof value === 'boolean') return value;
    if (depth >= 3) {
      truncated = true;
      return '[depth limit]';
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, 8).map((entry) => bounded(entry, depth + 1));
      if (value.length > 8) truncated = true;
      return value.length > 8 ? { total: value.length, items, truncated: true } : items;
    }
    if (object(value)) {
      const keys = Object.keys(value);
      if (keys.length > 8) truncated = true;
      return {
        ...Object.fromEntries(
          keys.slice(0, 8).map((key) => [key.slice(0, 80), bounded(value[key], depth + 1)]),
        ),
        ...(keys.length > 8 ? { omittedKeys: keys.length - 8 } : {}),
      };
    }
    return `[${typeof value}]`;
  };
  const select = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    if (!object(value)) return null;
    return Object.fromEntries(keys.map((key) => [key, bounded(value[key])]));
  };
  const world = record(input.snapshot);
  const entities = Array.isArray(world.entities) ? world.entities : [];
  const components = (name: string): Record<string, unknown> => {
    const found = entities.find((entity) => object(entity) && entity.name === name);
    return record(record(found).components);
  };
  const player = components('player');
  const threat = components('responder');
  const mission = components('mission');
  const observations = record(input.observations);
  const presentation = record(observations.presentation);
  const history = Array.isArray(input.events) ? input.events : [];
  const relevant = history.filter((event) => {
    const type = record(event).type;
    return (
      typeof type === 'string' &&
      (type.startsWith('horror.') ||
        ['player.died', 'entity.died', 'level.completed'].includes(type)) &&
      !['horror.player.step', 'horror.threat.step'].includes(type)
    );
  });
  const interactables = entities.filter(
    (entity) =>
      object(record(entity).components) &&
      object(record(record(entity).components).HorrorInteractable),
  );
  // Transport evidence is budgeted first, so long authored text/event payloads cannot displace it.
  const transport = {
    observation: select(observations, [
      'tick',
      'hash',
      'paused',
      'focused',
      'visibility',
      'activeElement',
      'pointerLocked',
    ]),
    presentation: {
      status: bounded(presentation.status),
      generation: bounded(presentation.generation),
      input: select(presentation.input, ['capture', 'transport']),
      audio: bounded(presentation.audio),
      ending: bounded(presentation.ending),
    },
    timings: select(observations.timings, [
      'frames',
      'snapshots',
      'gap',
      'meanGap',
      'worstGap',
      'restore',
      'sync',
      'render',
      'hud',
      'exchange',
      'exchangeBytes',
      'exchangeErrors',
      'firstExchangeFailure',
      'inFlight',
    ]),
    firstExchangeFailure: select(record(observations.timings).firstExchangeFailure, [
      'stage',
      'responseStatus',
      'message',
      'name',
      'elapsedMs',
      'requestSequence',
      'requestGeneration',
      'generation',
      'tick',
      'renderedGeneration',
      'lastRenderMs',
      'longestRenderWhilePendingMs',
    ]),
  };
  const result = {
    ...transport,
    world: { tick: bounded(world.tick), entities: entities.length, resources: 'omitted' },
    mission: select(mission.HorrorMission, [
      'arrived',
      'fuse',
      'service',
      'busIsolated',
      'power',
      'visitorToken',
      'recorder',
      'coolant',
      'uplink',
      'escaped',
      'dead',
      'completedTick',
      'evidence',
    ]),
    player: {
      position: bounded(record(player.Transform).position),
      look: select(player.LookState, ['yawDeg', 'pitchDeg']),
      health: select(player.Health, ['current', 'max']),
      dead: player.Dead !== undefined,
      body: select(player.CapsuleBody, ['velocity', 'grounded']),
      movement: select(player.FpsController, ['moveSpeed']),
      state: select(player.HorrorPlayer, [
        'flashlight',
        'crouched',
        'sprinting',
        'stamina',
        'exhausted',
        'noise',
        'distance',
        'footstep',
      ]),
      status: select(player.HorrorStatus, [
        'objective',
        'prompt',
        'subtitle',
        'subtitleUntil',
        'threat',
        'ended',
        'musicPhase',
      ]),
    },
    threat: {
      position: bounded(record(threat.Transform).position),
      state: select(threat.HorrorThreat, [
        'mode',
        'suspicion',
        'lostTicks',
        'searchTicks',
        'attackTicks',
        'warningCooldown',
        'patrolIndex',
        'targetX',
        'targetZ',
        'repathTicks',
        'footstep',
        'hadChase',
      ]),
      path: bounded(record(threat.HorrorThreat).path),
    },
    interactables: {
      total: interactables.length,
      returned: Math.min(interactables.length, 16),
      items: interactables.slice(0, 16).map((entity) => ({
        name: bounded(record(entity).name),
        state: select(record(record(entity).components).HorrorInteractable, [
          'kind',
          'selection',
          'progress',
          'holdTicks',
          'used',
        ]),
      })),
    },
    events: {
      available: Array.isArray(input.events),
      total: history.length,
      relevant: relevant.length,
      returned: Math.min(relevant.length, 24),
      limit: 24,
      items: relevant
        .slice(-24)
        .map((event) => select(event, ['type', 'tick', 'sequence', 'data'])),
    },
  };
  return {
    ...result,
    bounds: {
      valueNodes: Math.min(valueNodes, 512),
      maxValueNodes: 512,
      textChars,
      maxTextChars: 8192,
      truncated,
    },
  };
}

/** No imports or outer values: this function executes in the page only after a test fails. */
function readBrowser(project: typeof projectHorrorFailure): Record<string, unknown> {
  const debug = (
    globalThis as typeof globalThis & {
      aegis?: {
        world: { snapshot(): unknown; hash(): string };
        tick(): number;
        paused?(): boolean;
        events?(): unknown;
        presentation(): unknown;
        timings?(): unknown;
      };
    }
  ).aegis;
  if (debug === undefined) throw new Error('The page has no aegis debug handle.');
  return project({
    snapshot: debug.world.snapshot(),
    events: debug.events?.(),
    observations: {
      tick: debug.tick(),
      hash: debug.world.hash(),
      paused:
        debug.paused?.() ??
        document.getElementById('action-pause')?.getAttribute('aria-pressed') === 'true',
      presentation: debug.presentation(),
      timings: debug.timings?.(),
      focused: document.hasFocus(),
      visibility: document.visibilityState,
      activeElement: document.activeElement?.id ?? null,
      pointerLocked: document.pointerLockElement?.id ?? null,
    },
  });
}

export const HORROR_FAILURE_EXPRESSION = `(${readBrowser.toString()})(${projectHorrorFailure.toString()})`;
const DIAGNOSTIC_TIMEOUT_MS = 3000;

/**
 * Called only by the two route tests' catch blocks, before page disposal. No extra reads on pass.
 * A failed diagnostic read is evidence, not a reason to replace or swallow the original failure.
 */
export async function reportHorrorFailure(
  failure: unknown,
  options: {
    label: string;
    page: { send(method: string, params: object, timeoutMs: number): Promise<unknown> };
    authoritative?: () => Parameters<typeof projectHorrorFailure>[0];
    emit?: (line: string) => void;
  },
): Promise<void> {
  const describe = (error: unknown): string =>
    (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 600);
  const capture = (read: () => Record<string, unknown>): object => {
    try {
      return { available: true, value: read() };
    } catch (error) {
      return { available: false, error: describe(error) };
    }
  };
  const authoritative =
    options.authoritative === undefined
      ? { available: false, reason: 'Static simulation is local to the browser.' }
      : capture(() => projectHorrorFailure(options.authoritative!()));
  let browser: object;
  try {
    const reply = await options.page.send(
      'Runtime.evaluate',
      {
        expression: HORROR_FAILURE_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
      DIAGNOSTIC_TIMEOUT_MS,
    );
    if (typeof reply !== 'object' || reply === null || !('result' in reply))
      throw new Error('Diagnostic evaluation returned no result.');
    if ('exceptionDetails' in reply)
      throw new Error(
        `Diagnostic evaluation threw: ${JSON.stringify(reply.exceptionDetails).slice(0, 600)}`,
      );
    const result = reply.result;
    if (typeof result !== 'object' || result === null || !('value' in result))
      throw new Error('Diagnostic evaluation returned no value.');
    browser = { available: true, value: result.value };
  } catch (error) {
    browser = { available: false, error: describe(error) };
  }
  const report = {
    kind: 'horror-failure/1',
    label: options.label.slice(0, 160),
    originalFailure: describe(failure),
    authoritative,
    browser,
  };
  const line = `[horror-failure] ${JSON.stringify(report)}`;
  let emissionFailure = '';
  try {
    (options.emit ?? console.error)(line);
  } catch (error) {
    emissionFailure = `\n[horror-failure] Diagnostic output failed: ${describe(error)}`;
  }
  if (failure instanceof Error) {
    failure.message += `\n${line}${emissionFailure}`;
    if (failure.stack !== undefined) failure.stack += `\n${line}${emissionFailure}`;
  }
}

/** Cleanup still fails passing cases, but cannot replace an already reported assertion failure. */
export async function closeHorrorPage(
  page: { send(method: string, params: object): Promise<unknown>; close(): void },
  alreadyFailed: boolean,
): Promise<void> {
  try {
    await page.send('Page.navigate', { url: 'about:blank' });
  } catch (error) {
    if (!alreadyFailed) throw error;
    console.error('[horror-failure] Page cleanup also failed:', String(error).slice(0, 600));
  } finally {
    page.close();
  }
}
