#!/usr/bin/env node
/**
 * aegis-animation: headless validation and import of 2D animation documents (ANIM-07).
 *
 *   aegis-animation validate <file-or-directory>... [--lines <audio-pack.json>]... [--durations <map.json>] [--json]
 *   aegis-animation import-rhubarb <rhubarb.json> --line <id> [--revision <r>] [--out <file>]
 *   aegis-animation import-azure <events.json> --line <id> --duration <seconds> [--revision <r>] [--out <file>]
 *
 * `validate` reads every *.json under the given paths, keeps the animation documents
 * (aegis-atlas/1, aegis-rig/1, aegis-clip/1, aegis-cues/1, aegis-cutscene/1) and validates them
 * together. `--lines` takes AudioPack manifests so cutscene lines are checked for captions;
 * `--durations` maps line IDs to audio seconds so stale cue tracks are reported.
 * Exit codes: 0 valid (warnings allowed), 2 invalid documents, 64 usage error.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import { importRhubarb, importVisemes, validateBundle } from '../dist/animation/index.js';

const FORMATS = new Set([
  'aegis-atlas/1',
  'aegis-rig/1',
  'aegis-clip/1',
  'aegis-cues/1',
  'aegis-cutscene/1',
]);

function usage(message) {
  if (message) process.stderr.write(`aegis-animation: ${message}\n`);
  process.stderr.write(
    'Usage:\n  aegis-animation validate <paths...> [--lines <pack.json>] [--durations <map.json>] [--json]\n' +
      '  aegis-animation import-rhubarb <rhubarb.json> --line <id> [--revision <r>] [--out <file>]\n' +
      '  aegis-animation import-azure <events.json> --line <id> --duration <s> [--revision <r>] [--out <file>]\n',
  );
  process.exit(64);
}

function parse(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.set('json', [true]);
    else if (arg.startsWith('--')) {
      const value = argv[++i];
      if (value === undefined) usage(`${arg} needs a value`);
      flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value]);
    } else positional.push(arg);
  }
  return { positional, flags };
}

function jsonFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.name === 'node_modules' || entry.name.startsWith('.')
      ? []
      : entry.isDirectory()
        ? jsonFiles(join(path, entry.name))
        : entry.name.endsWith('.json')
          ? [join(path, entry.name)]
          : [],
  );
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parse(rest);
const one = (name) => flags.get(name)?.[0];

if (command === 'validate') {
  if (!positional.length) usage('validate needs at least one path');
  const documents = [];
  let skipped = 0;
  for (const root of positional)
    for (const file of jsonFiles(root)) {
      let value;
      try {
        value = read(file);
      } catch (cause) {
        documents.push({
          source: relative(process.cwd(), file),
          value: `not JSON: ${cause.message}`,
        });
        continue;
      }
      if (value && typeof value === 'object' && FORMATS.has(value.format))
        documents.push({ source: relative(process.cwd(), file), value });
      else skipped++;
    }
  const lines = new Set();
  for (const file of flags.get('lines') ?? [])
    for (const line of read(file).lines ?? [])
      if (typeof line.caption === 'string') lines.add(line.id);
  const durations = one('durations') ? new Map(Object.entries(read(one('durations')))) : undefined;
  const result = validateBundle({
    documents,
    ...(flags.has('lines') ? { lines } : {}),
    ...(durations ? { audioDurations: durations } : {}),
  });
  if (flags.has('json'))
    process.stdout.write(JSON.stringify({ ...result, skipped }, null, 2) + '\n');
  else {
    for (const d of result.diagnostics)
      process.stdout.write(
        `${d.severity} ${d.code} ${d.source ?? ''} at ${d.path}: ${d.message}\n`,
      );
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
    const counts = Object.entries(result.counts)
      .map(([format, count]) => `${String(count)} ${format}`)
      .join(', ');
    process.stdout.write(
      `-- ${String(errors)} error(s), ${String(result.diagnostics.length - errors)} warning(s) in ${counts || 'no animation documents'}; ${String(skipped)} other JSON file(s) skipped\n`,
    );
  }
  process.exit(result.ok ? 0 : 2);
} else if (command === 'import-rhubarb' || command === 'import-azure') {
  const [input] = positional;
  const line = one('line');
  if (!input || !line) usage(`${command} needs an input file and --line`);
  const revision = one('revision');
  const track =
    command === 'import-rhubarb'
      ? importRhubarb(read(input), { line, ...(revision ? { revision } : {}) })
      : importVisemes('azure', read(input), {
          line,
          duration: Number(one('duration')),
          ...(revision ? { revision } : {}),
        });
  const text = JSON.stringify(track, null, 2) + '\n';
  if (one('out')) writeFileSync(one('out'), text);
  else process.stdout.write(text);
} else usage(command ? `unknown command "${command}"` : undefined);
