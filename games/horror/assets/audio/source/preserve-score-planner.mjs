import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { argv, stdout } from 'node:process';
import { sha256 } from './audio-tools.mjs';

const [logPath, outputDirectory] = argv.slice(2);
if (!logPath || !outputDirectory) {
  throw new Error(
    'Usage: node preserve-score-planner.mjs <owned-ACE-stderr.log> <new-archive-dir>',
  );
}
const log = await readFile(logPath, 'utf8');
const matches = [
  ...log.matchAll(/Debug output text: ((?:<\|audio_code_\d+\|>)+)(?:<\|im_end\|>)?/g),
];
assert.equal(
  matches.length,
  1,
  'Expected one unambiguous planner audio-code payload in this job log',
);
const audioCodes = matches[0][1];
const codes = [...audioCodes.matchAll(/<\|audio_code_(\d+)\|>/g)].map((match) => Number(match[1]));
assert.equal(codes.length, 900, 'The 180-second 5Hz planner must contain exactly900 codes');
assert.ok(codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 63999));
await mkdir(outputDirectory, { recursive: true });
const output = join(outputDirectory, 'planner-codes.json');
const payloadSha256 = createHash('sha256').update(audioCodes, 'utf8').digest('hex');
await writeFile(
  output,
  `${JSON.stringify(
    {
      schema: 'null-meridian-planner-codes/1',
      sourceLog: resolve(logPath),
      sourceLogSha256: await sha256(logPath),
      extraction:
        'Exact serialized token payload from ACE parse_lm_output DEBUG line; no process injection or model invocation.',
      model: 'acestep-5Hz-lm-1.7B',
      count: codes.length,
      durationSeconds: 180,
      payloadSha256,
      codes,
      audioCodes,
    },
    null,
    2,
  )}\n`,
  { flag: 'wx' },
);
stdout.write(`${JSON.stringify({ output, count: codes.length, payloadSha256 }, null, 2)}\n`);
