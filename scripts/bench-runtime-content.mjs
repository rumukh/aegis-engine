#!/usr/bin/env node
/**
 * Benchmark: what one `@aegis/runtime` commit costs as the content pack grows (issue #7).
 *
 * Not part of `npm run verify`, and deliberately not a test: it reads a wall clock and its
 * numbers belong to the machine that produced them. It exists so a before/after comparison is
 * reproducible. It measures a **built** runtime, so build first:
 *
 *   npm run build
 *   node scripts/bench-runtime-content.mjs [--scale 1] [--rounds 5] [--dispatches 300]
 *                                          [--runtime <index.js>] [--json]
 *
 * By default the runtime under test is `@aegis/runtime`, i.e. this checkout's
 * `packages/runtime/dist`. `--runtime` imports another build's `index.js` instead, so two
 * revisions can be compared in alternating processes on one machine — which matters on a shared
 * box whose load drifts between runs. Copy the other revision's `packages/runtime/dist` to a
 * scratch directory inside this checkout (`.tmp/` is ignored by git), where it still resolves
 * `@aegis/core`, and pass the copy's `index.js`.
 *
 * The content pack is synthetic but shaped like a real game's: hundreds of records in nested
 * arrays and objects, about 130 KB of JSON at `--scale 1` (`--scale 0.4` is about 51 KB). The
 * adapter reads content where a real one does — in `resolve`, command and job rules, `validate`
 * and the view projection — schedules immediate jobs, mixes zero-, one- and two-turn commands,
 * and commits through an in-memory strict checkpoint writer.
 *
 * Everything is seeded. Every round must end on the same state hash, and the script exits
 * non-zero if one does not. The hash is printed so two builds can be compared for semantics as
 * well as for speed: a change that only removes redundant work must not move it.
 */
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { isMain, repositoryRoot } from './sdk-tools.mjs';

const WORDS = [
  'ember',
  'frost',
  'storm',
  'moss',
  'stone',
  'tide',
  'ash',
  'gale',
  'thorn',
  'glimmer',
  'cinder',
  'brook',
  'shade',
  'dawn',
  'dusk',
  'flint',
];

/** @param {number} index */
const word = (index) => WORDS[index % WORDS.length];

/** @param {number} seed @param {number} length */
const phrase = (seed, length) => Array.from({ length }, (_, k) => word(seed * 7 + k * 3)).join(' ');

/**
 * A deterministic content pack: facts, items, dragons, regions with encounters, and dialogue.
 * @param {number} scale multiplies every catalog's record count
 * @param {string} revision
 */
export function syntheticContent(scale = 1, revision = 'r1') {
  const count = (/** @type {number} */ base) => Math.max(1, Math.round(base * scale));
  const facts = Array.from({ length: count(144) }, (_, i) => {
    const a = 1 + (i % 12);
    const b = 1 + (Math.floor(i / 12) % 12);
    return {
      id: `fact-${i}`,
      a,
      b,
      product: a * b,
      tables: [a, b],
      hint: `${a} groups of ${b} make ${a * b}`,
      difficulty: (a * b) % 5,
    };
  });
  const items = Array.from({ length: count(80) }, (_, i) => ({
    id: `item-${i}`,
    name: `${word(i)} ${word(i + 5)} charm`,
    price: 5 + (i % 17) * 3,
    rarity: ['common', 'rare', 'epic'][i % 3],
    effects: Array.from({ length: 1 + (i % 3) }, (_, k) => ({
      kind: ['heal', 'shield', 'hint', 'luck'][(i + k) % 4],
      value: 1 + ((i + k) % 9),
    })),
  }));
  const dragons = Array.from({ length: count(40) }, (_, i) => ({
    id: `dragon-${i}`,
    name: `${word(i)}wing the ${word(i + 3)}`,
    element: ['fire', 'water', 'earth', 'air'][i % 4],
    stats: { hp: 20 + (i % 11) * 5, attack: 3 + (i % 7), defense: 2 + (i % 5), speed: 1 + (i % 4) },
    lines: {
      greet: [0, 1, 2].map((k) => phrase(i + k, 8)),
      taunt: [0, 1, 2].map((k) => phrase(i + k + 11, 8)),
      defeat: [0, 1, 2].map((k) => phrase(i + k + 23, 8)),
    },
  }));
  const regions = Array.from({ length: count(8) }, (_, r) => ({
    id: `region-${r}`,
    name: `${word(r)} valley`,
    requires: r === 0 ? [] : [`region-${r - 1}`],
    map: {
      width: 16,
      height: 8,
      rows: Array.from({ length: 8 }, (_, y) =>
        Array.from({ length: 16 }, (_, x) => '.#~^'[(x * 3 + y * 5 + r) % 4]).join(''),
      ),
    },
    encounters: Array.from({ length: 12 }, (_, e) => ({
      id: `region-${r}-encounter-${e}`,
      dragon: dragons[(r * 12 + e) % dragons.length].id,
      facts: Array.from(
        { length: 6 },
        (_, k) => facts[(r * 31 + e * 7 + k * 13) % facts.length].id,
      ),
      reward: { coins: 2 + ((r + e) % 6), item: items[(r * 12 + e) % items.length].id },
      dialogue: {
        intro: phrase(r * 12 + e, 10),
        win: phrase(r * 12 + e + 5, 8),
        lose: phrase(r * 12 + e + 9, 8),
      },
    })),
  }));
  const lines = count(320);
  const dialogue = Array.from({ length: lines }, (_, i) => ({
    id: `line-${i}`,
    speaker: dragons[i % dragons.length].id,
    text: phrase(i, 12),
    next: [`line-${(i + 1) % lines}`],
  }));
  return {
    id: 'bench-pack',
    revision,
    schemaVersion: 1,
    data: { facts, items, dragons, regions, dialogue },
  };
}

/**
 * The adapter is built from the runtime module under test, so schemas and outcomes come from
 * the same module instance as the host.
 * @param {typeof import('@aegis/runtime')} runtime
 */
export function benchAdapter({ failure, schema, success }) {
  const counter = schema.number({ integer: true, min: 0 });
  const answerPayload = schema.object({ fact: schema.string(), correct: schema.boolean });
  return {
    id: 'bench-runtime-content',
    stateVersion: 1,
    state: schema.object({
      region: schema.string(),
      encounter: counter,
      coins: counter,
      streak: counter,
      answered: counter,
      rested: counter,
      history: schema.array(answerPayload),
      inventory: schema.record(counter),
      log: schema.array(schema.string()),
    }),
    action: schema.union(
      schema.object({ type: schema.literal('answer'), fact: schema.string(), value: counter }),
      schema.object({ type: schema.literal('travel') }),
      schema.object({ type: schema.literal('rest') }),
    ),
    content: { schemaVersion: 1, schema: schema.json },
    eventPhases: ['ready'],
    initialize: ({ content }) => ({
      region: content.data.regions[0].id,
      encounter: 0,
      coins: 0,
      streak: 0,
      answered: 0,
      rested: 0,
      history: [],
      inventory: {},
      log: [],
    }),
    resolve(action, read) {
      if (action.type === 'travel') return success({ rule: 'travel', turns: 1, payload: null });
      if (action.type === 'rest') return success({ rule: 'rest', turns: 2, payload: null });
      const fact = read.content.data.facts.find((entry) => entry.id === action.fact);
      if (fact === undefined) return failure('unknown-fact', `No fact "${action.fact}".`);
      return success({
        rule: 'answer',
        turns: 0,
        payload: { fact: fact.id, correct: fact.product === action.value },
      });
    },
    commands: [
      {
        id: 'answer',
        payload: answerPayload,
        progress: schema.literal(null),
        start(context, pending) {
          const { fact, correct } = pending.payload;
          const state = context.state;
          state.answered++;
          state.streak = correct ? state.streak + 1 : 0;
          state.history.push({ fact, correct });
          if (state.history.length > 20) state.history.shift();
          context.emit('answer.checked', { fact, correct });
          if (!correct) return;
          const region = context.content.data.regions.find((entry) => entry.id === state.region);
          const encounter = region.encounters[state.encounter];
          state.coins += encounter.reward.coins;
          if (state.streak % 3 === 0) {
            context.schedule({
              id: `reward-${state.answered}`,
              rule: 'reward',
              payload: { item: encounter.reward.item },
              anchor: { kind: 'elapsed', turn: context.turn },
              phase: 'ready',
              priority: 0,
            });
          }
        },
      },
      {
        id: 'travel',
        payload: schema.literal(null),
        progress: schema.literal(null),
        turn(context) {
          const state = context.state;
          const regions = context.content.data.regions;
          const index = regions.findIndex((entry) => entry.id === state.region);
          if (state.encounter + 1 < regions[index].encounters.length) state.encounter++;
          else {
            state.region = regions[(index + 1) % regions.length].id;
            state.encounter = 0;
          }
          state.log.push(`travel:${context.turn}`);
          if (state.log.length > 20) state.log.shift();
        },
      },
      {
        id: 'rest',
        payload: schema.literal(null),
        progress: schema.literal(null),
        turn(context) {
          context.state.rested++;
          context.state.log.push(`rest:${context.turn}`);
          if (context.state.log.length > 20) context.state.log.shift();
        },
        finish(context) {
          context.emit('rest.finished');
        },
      },
    ],
    jobs: [
      {
        id: 'reward',
        payload: schema.object({ item: schema.string() }),
        run(context, job) {
          const item = context.content.data.items.find((entry) => entry.id === job.payload.item);
          context.state.inventory[item.id] = (context.state.inventory[item.id] ?? 0) + 1;
          context.emit('reward.granted', { item: item.id, price: item.price });
        },
      },
    ],
    validate(read) {
      const region = read.content.data.regions.find((entry) => entry.id === read.state.region);
      return region !== undefined && read.state.encounter < region.encounters.length
        ? success(undefined)
        : failure('missing-encounter', 'The active encounter is not in the content pack.');
    },
    view(read) {
      const data = read.content.data;
      const region = data.regions.find((entry) => entry.id === read.state.region);
      const encounter = region.encounters[read.state.encounter];
      const dragon = data.dragons.find((entry) => entry.id === encounter.dragon);
      return {
        region: region.name,
        dragon: dragon.name,
        greeting: dragon.lines.greet[read.state.answered % dragon.lines.greet.length],
        prompt: encounter.facts[read.state.answered % encounter.facts.length],
        coins: read.state.coins,
        streak: read.state.streak,
        items: Object.keys(read.state.inventory).length,
        turn: read.turn,
        revision: read.revision,
      };
    },
  };
}

/**
 * Nine commands in ten answer a fact (zero turns; every third consecutive correct answer
 * schedules an immediate reward job), then one travel (one turn) and one rest (two turns).
 * @param {ReturnType<typeof syntheticContent>} pack
 * @param {number} dispatches
 */
export function benchActions(pack, dispatches) {
  const facts = pack.data.facts;
  return Array.from({ length: dispatches }, (_, i) => {
    if (i % 10 === 8) return { type: 'travel' };
    if (i % 10 === 9) return { type: 'rest' };
    const fact = facts[(i * 7) % facts.length];
    return { type: 'answer', fact: fact.id, value: i % 5 === 0 ? fact.product + 1 : fact.product };
  });
}

/** @param {number[]} sorted @param {number} q */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** @param {number[]} values */
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One fresh host, every dispatch timed. The per-commit time of a dispatch is its duration
 * divided by the revisions it committed, so a two-turn rest counts as two commits.
 * @param {typeof import('@aegis/runtime')} runtime
 * @param {ReturnType<typeof benchAdapter>} adapter
 * @param {ReturnType<typeof syntheticContent>} pack
 * @param {ReturnType<typeof benchActions>} actions
 */
async function round(runtime, adapter, pack, actions) {
  const host = runtime.createRuntimeHost({
    adapter,
    content: pack,
    seed: 'bench-runtime-content',
    checkpoint: async () => runtime.success(undefined),
  });
  let lastView = host.getView();
  host.subscribe((view) => {
    lastView = view;
  });
  /** @type {number[]} */
  const perCommit = [];
  let elapsed = 0;
  for (const action of actions) {
    const before = host.getStatus().revision;
    const start = performance.now();
    runtime.requireValue(await host.dispatch(action));
    const duration = performance.now() - start;
    const commits = host.getStatus().revision - before;
    elapsed += duration;
    for (let k = 0; k < commits; k++) perCommit.push(duration / commits);
  }
  const inspections = 20;
  const inspectStart = performance.now();
  for (let k = 0; k < inspections; k++) host.inspect();
  const inspectMs = (performance.now() - inspectStart) / inspections;
  const result = {
    commits: host.getStatus().revision,
    elapsedMs: elapsed,
    perCommit,
    inspectMs,
    hash: host.hash(),
    coins: lastView.coins,
  };
  await host.dispose();
  return result;
}

/**
 * The content operations issue #7 names, timed on their own so the synthetic pack can be
 * compared with a real consumer's measurements. The fix does not change these functions.
 * @param {typeof import('@aegis/runtime')} runtime
 * @param {ReturnType<typeof syntheticContent>} pack
 * @param {number} iterations
 */
function contentCosts({ cloneData, dataHash, freezeData }, pack, iterations) {
  const time = (/** @type {() => unknown} */ operation) => {
    operation();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) operation();
    return (performance.now() - start) / iterations;
  };
  return {
    dataHashMs: time(() => dataHash(pack)),
    cloneDataMs: time(() => cloneData(pack)),
    freezeCloneMs: time(() => freezeData(cloneData(pack))),
  };
}

function revisionLabel() {
  try {
    const options = { cwd: repositoryRoot, encoding: /** @type {const} */ ('utf8') };
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], options).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], options).trim() !== '';
    return `${head}${dirty ? ' (working tree modified)' : ' (clean)'}`;
  } catch {
    return 'unknown';
  }
}

const NUMERIC = { '--scale': 'scale', '--rounds': 'rounds', '--dispatches': 'dispatches' };
const USAGE =
  'Usage: node scripts/bench-runtime-content.mjs [--scale <n>] [--rounds <n>] ' +
  '[--dispatches <n>] [--runtime <index.js>] [--json]';

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {{ scale: number; rounds: number; dispatches: number; runtime?: string; json: boolean }} */
  const options = { scale: 1, rounds: 5, dispatches: 300, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (flag === '--runtime' && value !== undefined) {
      options.runtime = value;
      i++;
      continue;
    }
    const key = NUMERIC[flag];
    const number = Number(value);
    if (key === undefined || !Number.isFinite(number) || number <= 0) {
      throw new Error(`Unknown or invalid argument "${flag} ${value ?? ''}". ${USAGE}`);
    }
    options[key] = key === 'scale' ? number : Math.max(1, Math.round(number));
    i++;
  }
  return options;
}

/** @param {ReturnType<typeof parseArguments>} options */
export async function runBenchmark(options) {
  const specifier =
    options.runtime === undefined ? '@aegis/runtime' : pathToFileURL(resolve(options.runtime)).href;
  /** @type {typeof import('@aegis/runtime')} */
  const runtime = await import(specifier);
  const adapter = benchAdapter(runtime);
  const pack = syntheticContent(options.scale);
  const actions = benchActions(pack, options.dispatches);
  await round(runtime, adapter, pack, actions); // warm-up: JIT and allocation, not reported
  const rounds = [];
  for (let r = 0; r < options.rounds; r++)
    rounds.push(await round(runtime, adapter, pack, actions));
  const hashes = [...new Set(rounds.map((entry) => entry.hash))];
  const pooled = rounds.flatMap((entry) => entry.perCommit).sort((a, b) => a - b);
  const data = pack.data;
  return {
    revision: revisionLabel(),
    runtime: options.runtime ?? '@aegis/runtime',
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    pack: {
      bytes: JSON.stringify(pack).length,
      records:
        data.facts.length +
        data.items.length +
        data.dragons.length +
        data.regions.length +
        data.regions.reduce((sum, region) => sum + region.encounters.length, 0) +
        data.dialogue.length,
      scale: options.scale,
    },
    workload: {
      dispatches: options.dispatches,
      commitsPerRound: rounds[0].commits,
      rounds: options.rounds,
    },
    content: contentCosts(runtime, pack, 20),
    perCommitMs: {
      mean: mean(pooled),
      p50: quantile(pooled, 0.5),
      p95: quantile(pooled, 0.95),
      max: pooled[pooled.length - 1],
      roundMeans: rounds.map((entry) => entry.elapsedMs / entry.commits),
    },
    inspectMs: mean(rounds.map((entry) => entry.inspectMs)),
    finalHash: hashes.length === 1 ? hashes[0] : null,
    finalHashes: hashes,
    finalCoins: rounds[0].coins,
  };
}

/** @param {Awaited<ReturnType<typeof runBenchmark>>} report */
function printReport(report) {
  const ms = (/** @type {number} */ value) => `${value.toFixed(2)} ms`;
  const lines = [
    '@aegis/runtime content benchmark (issue #7)',
    `revision  : ${report.revision} · runtime ${report.runtime}`,
    `node      : ${report.node} · ${report.platform} · ${report.cpu}`,
    `pack      : ${report.pack.bytes.toLocaleString('en-US')} bytes of JSON · ` +
      `${report.pack.records} records · scale ${report.pack.scale}`,
    `workload  : ${report.workload.dispatches} dispatches -> ${report.workload.commitsPerRound} ` +
      `commits per round · strict in-memory checkpoint · ${report.workload.rounds} rounds ` +
      '(+1 warm-up)',
    `content   : dataHash ${ms(report.content.dataHashMs)} · cloneData ` +
      `${ms(report.content.cloneDataMs)} · freezeData(cloneData) ` +
      `${ms(report.content.freezeCloneMs)} (one call each)`,
    `per commit: mean ${ms(report.perCommitMs.mean)} · p50 ${ms(report.perCommitMs.p50)} · ` +
      `p95 ${ms(report.perCommitMs.p95)} · max ${ms(report.perCommitMs.max)}`,
    `            round means: ` +
      `${report.perCommitMs.roundMeans.map((value) => value.toFixed(2)).join(' ')} ms`,
    `inspect() : ${ms(report.inspectMs)} per call`,
    `final hash: ${report.finalHash ?? `DIFFERS ACROSS ROUNDS: ${report.finalHashes.join(', ')}`}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (isMain(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  const report = await runBenchmark(options);
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
  // Every round replays the same seeded commands; a second hash is a determinism defect.
  if (report.finalHash === null) process.exitCode = 1;
}
