import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { isMain, npm, readJson, repositoryRoot, run } from './sdk-tools.mjs';

export const sdkPackages = ['core', 'runtime', 'narrative', 'browser'];
const rootInputs = [
  'LICENSE',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'scripts/pack-sdk.mjs',
  'scripts/sdk-tools.mjs',
];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      if (['dist', 'node_modules', '.git'].includes(entry.name)) return [];
      if (entry.name.endsWith('.tsbuildinfo')) return [];
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Source links are not supported: ${path}`);
      return entry.isDirectory() ? filesUnder(path) : [path];
    });
}

/** Digest bytes, not mtimes or Git's index: untracked package inputs count too. */
export function sourceInventory(root) {
  const paths = [
    ...rootInputs.map((path) => join(root, path)),
    ...sdkPackages.flatMap((name) => filesUnder(join(root, 'packages', name))),
  ];
  return paths
    .map((path) => ({
      path: relative(root, path).split(sep).join('/'),
      sha256: sha256(readFileSync(path)),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function distributionManifest(source, version) {
  if (!source.exports?.['.']?.types || !source.exports?.['.']?.import) {
    throw new Error(`${source.name}: explicit root types/import exports are required`);
  }
  if (source.license !== 'MIT') throw new Error(`${source.name}: unsupported license`);
  const dependencies = {};
  for (const [name] of Object.entries(source.dependencies ?? {})) {
    if (!sdkPackages.some((part) => name === `@aegis/${part}`)) {
      throw new Error(`${source.name}: runtime dependency outside the packed SDK: ${name}`);
    }
    dependencies[name] = version;
  }
  if (source.peerDependencies || source.optionalDependencies || source.bundledDependencies) {
    throw new Error(`${source.name}: review additional dependency kinds before packing`);
  }
  return {
    ...source,
    version,
    private: true,
    files: ['dist', 'src', 'LICENSE', 'aegis-build.json'],
    dependencies,
    scripts: undefined,
    devDependencies: undefined,
  };
}

function exportFiles(exports) {
  if (typeof exports === 'string') {
    if (!exports.startsWith('./') || exports.includes('*') || exports.includes('..', 2)) {
      throw new Error(`Only explicit package-relative exports are supported: ${exports}`);
    }
    return [exports];
  }
  if (!exports || typeof exports !== 'object') throw new Error('Invalid package exports');
  return Object.values(exports).flatMap(exportFiles);
}

/**
 * Build from a frozen copy, never from potentially stale live dist output.
 * Dirty inputs require consent and get their own content-addressed version.
 * @param {{revision: string, outDir?: string, allowDirty?: boolean, root?: string}} options
 */
export function packSdk({ revision, outDir, allowDirty = false, root = repositoryRoot }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) {
    throw new Error('Supply --revision with the full pinned 40-character Git commit.');
  }
  const head = run('git', ['rev-parse', 'HEAD'], root);
  if (head !== revision) throw new Error(`Pinned revision ${revision} differs from HEAD ${head}`);
  const scope = [...rootInputs, ...sdkPackages.map((name) => `packages/${name}`)];
  const inventory = sourceInventory(root);
  const tracked = new Set(run('git', ['ls-files', '-z', '--', ...scope], root).split('\0'));
  const untrackedInputs = inventory
    .filter((entry) => !tracked.has(entry.path))
    .map((entry) => entry.path);
  const dirty =
    run('git', ['status', '--porcelain', '--untracked-files=all', '--', ...scope], root) ||
    (untrackedInputs.length ? `Untracked build inputs:\n${untrackedInputs.join('\n')}` : '');
  if (dirty && !allowDirty) {
    throw new Error('SDK source is dirty. Commit it or explicitly use --allow-dirty.\n' + dirty);
  }
  const typescript = readJson(join(root, 'node_modules', 'typescript', 'package.json')).version;
  const npmVersion = npm(['--version'], root);
  const inputDigest = sha256(
    JSON.stringify({ inventory, typescript, npmVersion, node: process.version }),
  );
  const version = `0.0.0-local.r${revision.slice(0, 12)}.d${inputDigest.slice(0, 16)}`;
  const output = resolve(outDir ?? join(root, 'out', 'sdk', version));
  if (existsSync(output)) throw new Error(`Refusing to overwrite an artifact set: ${output}`);
  const stage = mkdtempSync(join(tmpdir(), 'aegis-sdk-build-'));
  const artifactStage = join(stage, 'artifacts');
  const provenance = {
    format: 'aegis-sdk-build/1',
    revision,
    workingTree: dirty ? 'modified' : 'clean',
    sourceDigest: inputDigest,
    sourceFiles: inventory,
    tools: { node: process.version, npm: npmVersion, typescript },
  };
  try {
    for (const entry of inventory) {
      const destination = join(stage, entry.path);
      mkdirSync(join(destination, '..'), { recursive: true });
      cpSync(join(root, entry.path), destination);
      if (sha256(readFileSync(destination)) !== entry.sha256) {
        throw new Error(`Source changed while staging: ${entry.path}; retry the build.`);
      }
    }
    mkdirSync(join(stage, 'node_modules', '@aegis'), { recursive: true });
    mkdirSync(artifactStage);
    for (const name of sdkPackages) {
      const directory = join(stage, 'packages', name);
      const manifest = distributionManifest(readJson(join(directory, 'package.json')), version);
      writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
      cpSync(join(stage, 'LICENSE'), join(directory, 'LICENSE'));
      writeFileSync(
        join(directory, 'aegis-build.json'),
        JSON.stringify(provenance, null, 2) + '\n',
      );
      symlinkSync(directory, join(stage, 'node_modules', '@aegis', name), 'junction');
    }
    run(
      process.execPath,
      [
        join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-b',
        ...sdkPackages.map((name) => join(stage, 'packages', name)),
      ],
      stage,
    );
    const packages = [];
    for (const name of sdkPackages) {
      const directory = join(stage, 'packages', name);
      const manifest = readJson(join(directory, 'package.json'));
      for (const target of exportFiles(manifest.exports)) {
        if (!lstatSync(join(directory, target)).isFile())
          throw new Error(`Missing export ${target}`);
      }
      const [packed] = JSON.parse(
        npm(['pack', '--ignore-scripts', '--json', '--pack-destination', artifactStage], directory),
      );
      const included = new Set(packed.files.map((file) => file.path));
      for (const target of [
        'LICENSE',
        'aegis-build.json',
        'package.json',
        ...exportFiles(manifest.exports),
      ]) {
        if (!included.has(target.replace(/^\.\//, ''))) {
          throw new Error(`${manifest.name}: npm pack omitted ${target}`);
        }
      }
      packages.push({
        name: manifest.name,
        version,
        file: packed.filename,
        sha256: sha256(readFileSync(join(artifactStage, packed.filename))),
        integrity: packed.integrity,
      });
    }
    const report = { ...provenance, version, packages };
    writeFileSync(join(artifactStage, 'artifacts.json'), JSON.stringify(report, null, 2) + '\n');
    mkdirSync(join(output, '..'), { recursive: true });
    cpSync(artifactStage, output, { recursive: true, errorOnExist: true, force: false });
    return { ...report, directory: output };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = { revision: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--allow-dirty') options.allowDirty = true;
    else if (args[i] === '--revision') options.revision = args[++i];
    else if (args[i] === '--out') options.outDir = args[++i];
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const report = packSdk(options);
  console.log(JSON.stringify(report, null, 2));
}
