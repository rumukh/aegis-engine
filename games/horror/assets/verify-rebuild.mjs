import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const options = new Map();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (
    !['--scene', '--scratch', '--scope'].includes(args[i]) ||
    !args[i + 1] ||
    options.has(args[i])
  )
    throw new Error(
      'Usage: node games\\horror\\assets\\verify-rebuild.mjs --scene <canonical scene> --scratch <new temporary directory> [--scope optics]',
    );
  options.set(args[i], args[i] === '--scope' ? args[i + 1] : resolve(args[i + 1]));
}
if (options.has('--scope') && options.get('--scope') !== 'optics')
  throw new Error('Unknown rebuild scope');
const opticsOnly = options.get('--scope') === 'optics';
if (!options.has('--scene') || !options.has('--scratch'))
  throw new Error('Explicit scene and newly created scratch paths are required');
const expected = JSON.parse(await readFile(join(here, 'generated', 'inventory.json'), 'utf8'));
const bytes = await readFile(options.get('--scene'));
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(
  sha256,
  expected.sourceScene.sha256,
  'Scene changed since publication; recook before comparing exact inputs',
);
const scratch = options.get('--scratch');
await mkdir(scratch);
let failure;
try {
  const scene = join(scratch, 'pinned-input.scene.json');
  const output = join(scratch, 'generated');
  await writeFile(scene, bytes, { flag: 'wx' });
  if (opticsOnly)
    await cp(join(here, 'generated'), output, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  await promisify(execFile)(
    process.execPath,
    [
      join(here, 'generate.mjs'),
      '--scene',
      scene,
      '--out',
      output,
      ...(opticsOnly ? ['--scope', 'optics'] : []),
    ],
    {
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const rebuilt = JSON.parse(await readFile(join(output, 'inventory.json'), 'utf8'));
  assert.deepEqual(
    rebuilt.recipeInputs,
    expected.recipeInputs,
    'Cooking source changed during rebuild',
  );
  assert.deepEqual(rebuilt.toolchain, expected.toolchain);
  assert.deepEqual(rebuilt.files, expected.files, 'Independent rebuild changed runtime bytes');
  const report = {
    passed: true,
    scope: opticsOnly
      ? 'Only two optical models and ring-density image independently rebuilt;33 other runtime files copied and hash-verified, not rebuilt. Not an artistic correctness oracle.'
      : 'Byte-for-byte reproducibility from retained sources, not an independent art or gameplay correctness oracle',
    rebuiltRuntimeFiles: opticsOnly
      ? ['responder.glb', 'orbital-exterior.glb', 'ring-density.png']
      : rebuilt.files.map((file) => file.file),
    sourceSceneSha256: sha256,
    toolchain: expected.toolchain,
    filesCompared: rebuilt.files.length,
    bytesCompared: rebuilt.budget.totalBytes,
    files: rebuilt.files,
  };
  await writeFile(`${scratch}.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify({ ...report, files: undefined, report: `${scratch}.json` }, null, 2)}\n`,
  );
} catch (error) {
  failure = error;
}
try {
  await rm(scratch, { recursive: true, force: true });
} catch (cleanupError) {
  failure = failure
    ? new AggregateError([failure, cleanupError], 'Rebuild and owned scratch cleanup failed')
    : cleanupError;
}
if (failure) throw failure;
