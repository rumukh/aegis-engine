import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sdkPackages, sha256 } from './pack-sdk.mjs';
import { isMain, npm, readJson, repositoryRoot, run } from './sdk-tools.mjs';

function refuseSymlinks(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Isolated package contains a symlink: ${path}`);
    if (stat.isDirectory()) refuseSymlinks(path);
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Installs only tarballs and pinned tooling into a new OS-temp project, not a workspace. */
export function testStandaloneConsumer({ artifactDir, keep = false, root = repositoryRoot }) {
  const artifacts = readJson(join(artifactDir, 'artifacts.json'));
  const directory = mkdtempSync(join(tmpdir(), 'aegis-independent-consumer-'));
  const relativeDirectory = relative(root, directory);
  if (!isAbsolute(relativeDirectory) && !relativeDirectory.startsWith(`..${sep}`)) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error('The consumer must be outside the engine repository.');
  }
  try {
    mkdirSync(join(directory, 'vendor'));
    const dependencies = {};
    for (const name of sdkPackages) {
      const artifact = artifacts.packages.find((item) => item.name === `@aegis/${name}`);
      if (!artifact || artifact.version !== artifacts.version) {
        throw new Error(`Missing or mismatched artifact: @aegis/${name}`);
      }
      if (!/^[a-z0-9.-]+\.tgz$/.test(artifact.file)) throw new Error('Invalid artifact filename');
      const tarball = join(artifactDir, artifact.file);
      if (sha256(readFileSync(tarball)) !== artifact.sha256) {
        throw new Error(`Artifact digest mismatch: ${artifact.file}`);
      }
      cpSync(tarball, join(directory, 'vendor', artifact.file));
      dependencies[artifact.name] = `file:vendor/${artifact.file}`;
    }
    const lock = readJson(join(root, 'package-lock.json'));
    writeJson(join(directory, 'package.json'), {
      name: 'aegis-independent-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies,
      devDependencies: {
        typescript: lock.packages['node_modules/typescript'].version,
        esbuild: lock.packages['node_modules/esbuild'].version,
      },
    });
    cpSync(join(root, '.npmrc'), join(directory, '.npmrc'));
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
    const installed = [];
    const exports = [];
    for (const name of sdkPackages) {
      const packageDir = join(directory, 'node_modules', '@aegis', name);
      refuseSymlinks(packageDir);
      const manifest = readJson(join(packageDir, 'package.json'));
      if (manifest.version !== artifacts.version)
        throw new Error(`Wrong installed version: ${name}`);
      const build = readJson(join(packageDir, 'aegis-build.json'));
      if (build.sourceDigest !== artifacts.sourceDigest)
        throw new Error(`Wrong provenance: ${name}`);
      if (!readFileSync(join(packageDir, 'LICENSE'), 'utf8').includes('MIT License')) {
        throw new Error(`Missing license: ${name}`);
      }
      for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
        if (!dependencies[dependency] || version !== artifacts.version) {
          throw new Error(
            `Unpinned sibling dependency: ${manifest.name} -> ${dependency}@${version}`,
          );
        }
      }
      exports.push(
        ...Object.keys(manifest.exports).map((key) => ({
          specifier: key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`,
          browser: name === 'browser',
        })),
      );
      installed.push({ name: manifest.name, version: manifest.version });
    }
    const entry = (entries) =>
      entries
        .map(({ specifier }, i) => `import * as api${i} from ${JSON.stringify(specifier)};`)
        .join('\n') +
      '\nexport const exports = [' +
      entries.map((_, i) => `Object.keys(api${i}).sort()`).join(', ') +
      '];\n';
    writeFileSync(join(directory, 'browser.ts'), entry(exports));
    writeFileSync(
      join(directory, 'headless.ts'),
      entry(exports.filter((item) => !item.browser)) +
        "import { createPrng } from '@aegis/core';\n" +
        "const random = createPrng('independent-consumer');\n" +
        'export const randomState = random.save();\n',
    );
    const compilerOptions = {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    };
    writeJson(join(directory, 'tsconfig.json'), {
      compilerOptions: { ...compilerOptions, lib: ['ES2022', 'DOM', 'DOM.Iterable'] },
      files: ['browser.ts'],
    });
    writeJson(join(directory, 'tsconfig.headless.json'), {
      compilerOptions: { ...compilerOptions, lib: ['ES2022'] },
      files: ['headless.ts'],
    });
    for (const config of ['tsconfig.json', 'tsconfig.headless.json']) {
      run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', config], directory);
    }
    writeFileSync(
      join(directory, 'build.mjs'),
      `import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
const forbidden = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
for (const [entry, platform] of [['browser', 'browser'], ['headless', 'node']]) {
  const result = await build({
    entryPoints: [entry + '.ts'], outfile: entry + '.mjs',
    bundle: true, platform, format: 'esm', target: 'es2022',
    treeShaking: false, metafile: true,
    plugins: [{ name: 'public-browser-boundary', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (forbidden.has(args.path) || args.path === 'three' || args.path.startsWith('three/') ||
            args.path === '@aegis/render-three' || args.path.startsWith('@aegis/render-three/'))
          throw new Error('Forbidden SDK dependency: ' + args.path);
      });
    } }],
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some(path => path.includes('../') || path.includes('render-three') || path.includes('node_modules/three/')))
    throw new Error('Bundle escaped the independent consumer');
  writeFileSync(entry + '.metafile.json', JSON.stringify(result.metafile, null, 2));
}
const { exports: surface, randomState } = await import('./headless.mjs');
if (surface.length < 4 || surface.some(keys => keys.length === 0) || !randomState)
  throw new Error('Headless public exports did not execute');
console.log(JSON.stringify({ publicExports: surface.length, randomState }));
`,
    );
    const smoke = JSON.parse(run(process.execPath, ['build.mjs'], directory));
    mkdirSync(join(directory, 'poc'));
    mkdirSync(join(directory, 'scripts'));
    for (const name of ['storybook-lab', 'turn-kitchen-lab', 'lab-shared']) {
      cpSync(join(root, 'poc', name), join(directory, 'poc', name), { recursive: true });
    }
    for (const name of ['sdk-tools.mjs', 'build-labs.mjs', 'run-labs.mjs']) {
      cpSync(join(root, 'scripts', name), join(directory, 'scripts', name));
    }
    writeJson(join(directory, 'tsconfig.labs.json'), {
      compilerOptions: { ...compilerOptions, lib: ['ES2022', 'DOM', 'DOM.Iterable'] },
      include: ['poc/**/*.ts'],
    });
    run(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.labs.json'],
      directory,
    );
    const trace = JSON.parse(run(process.execPath, ['scripts/run-labs.mjs'], directory));
    const site = JSON.parse(
      run(process.execPath, ['scripts/build-labs.mjs', '--base', '/independent/labs/'], directory),
    );
    const report = {
      format: 'aegis-independent-consumer/1',
      sourceRevision: artifacts.revision,
      sourceDigest: artifacts.sourceDigest,
      version: artifacts.version,
      installed,
      publicEntries: exports.map((item) => item.specifier),
      checks: [
        'tarball-digests',
        'no-package-symlinks',
        'exact-siblings',
        'licenses',
        'browser-types',
        'headless-types',
        'browser-bundle',
        'headless-bundle',
        'headless-execution',
        'reference-types',
        'reference-headless-traces',
        'reference-static-build',
      ],
      smoke,
      trace,
      site,
      browserInputs: Object.keys(readJson(join(directory, 'browser.metafile.json')).inputs),
    };
    writeJson(join(directory, 'consumer-report.json'), report);
    return { ...report, directory: keep ? directory : undefined };
  } finally {
    if (!keep) rmSync(directory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let artifactDir;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--artifacts') artifactDir = resolve(args[++i]);
    else if (args[i] === '--keep') keep = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!artifactDir) throw new Error('Supply --artifacts with a pack:sdk output directory.');
  console.log(JSON.stringify(testStandaloneConsumer({ artifactDir, keep }), null, 2));
}
