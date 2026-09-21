import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { isMain, repositoryRoot } from './sdk-tools.mjs';
import { atmosphereWav } from '../poc/lab-shared/atmosphere.mjs';

export function validateBase(base) {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) {
    throw new Error('Base must be an absolute directory URL, e.g. /aegis/labs/.');
  }
  return base;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export async function buildLabs({ outDir, base = '/', root = repositoryRoot }) {
  validateBase(base);
  const output = resolve(outDir ?? join(root, 'out', 'labs'));
  if (existsSync(output)) throw new Error(`Refusing to overwrite a lab build: ${output}`);
  mkdirSync(output, { recursive: true });
  const entries = ['storybook-lab', 'turn-kitchen-lab'];
  const result = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(
      entries.map((name) => [name + '/app', 'poc/' + name + '/main.ts']),
    ),
    outdir: output,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    metafile: true,
    sourcemap: false,
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(
    (path) => path.includes('render-three') || path.includes('node_modules/three/'),
  );
  if (forbidden.length) throw new Error('The labs imported rendering: ' + forbidden.join(', '));
  cpSync(join(root, 'poc', 'lab-shared', 'assets'), join(output, 'assets'), { recursive: true });
  cpSync(join(root, 'poc', 'lab-shared', 'style.css'), join(output, 'style.css'));
  writeFileSync(join(output, 'assets', 'atmosphere-slow.wav'), atmosphereWav(4));
  writeFileSync(join(output, 'assets', 'atmosphere-fast.wav'), atmosphereWav(2));
  for (const name of entries) {
    cpSync(
      join(root, 'poc', name, name === 'turn-kitchen-lab' ? 'balance.json' : 'content.json'),
      join(output, name, name === 'turn-kitchen-lab' ? 'balance.json' : 'content.json'),
    );
    writeFileSync(
      join(output, name, 'index.html'),
      `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="aegis-base" content="${base}"><meta name="aegis-pack-revision" content="BUILD_REVISION"><title>${name}</title>
<link rel="stylesheet" href="../style.css"></head><body>
<div id="app" aria-busy="true"></div><script type="module" src="./app.js"></script></body></html>\n`,
    );
  }
  writeFileSync(
    join(output, 'index.html'),
    `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="./style.css"><title>AEGIS: лаборатории</title></head><body><main>
<h1>Маленькие истории</h1><nav><a href="./storybook-lab/">Комната историй</a>
<a href="./turn-kitchen-lab/">Мастерская ходов</a></nav></main></body></html>\n`,
  );
  const printModule = await build({
    absWorkingDir: root,
    stdin: {
      contents: "export { printReference } from './poc/storybook-lab/extras.ts';",
      resolveDir: root,
      loader: 'ts',
    },
    write: false,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
  });
  const { printReference } = await import(
    'data:text/javascript;base64,' +
      Buffer.from(
        printModule.outputFiles[0].text + '\n//# sourceURL=aegis-lab-printer.mjs',
      ).toString('base64')
  );
  for (const paper of ['A4', 'Letter']) {
    const html = printReference(paper).replace(
      '</style>',
      "@font-face{font-family:'Lab Sans';src:url('./assets/NotoSans.ttf')}body{font-family:'Lab Sans',sans-serif}</style>",
    );
    writeFileSync(join(output, `print-${paper.toLowerCase()}.html`), html);
  }
  const resourceList = () =>
    files(output).map((path) => {
      const data = readFileSync(path);
      const extension = path.split('.').pop();
      const kind =
        {
          html: 'shell',
          js: 'script',
          svg: 'image',
          ttf: 'font',
          woff2: 'font',
          wav: 'audio',
          ogg: 'audio',
          mp3: 'audio',
          css: 'style',
        }[extension] ?? 'data';
      return {
        id:
          'file-' +
          createHash('sha256')
            .update(relative(output, path).split(sep).join('/'))
            .digest('hex')
            .slice(0, 24),
        src: base + relative(output, path).split(sep).join('/'),
        sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
        kind,
      };
    });
  const revision = createHash('sha256')
    .update(JSON.stringify(resourceList()))
    .digest('hex')
    .slice(0, 24);
  for (const name of entries) {
    const path = join(output, name, 'index.html');
    writeFileSync(path, readFileSync(path, 'utf8').replace('BUILD_REVISION', revision));
  }
  const resources = resourceList();
  writeFileSync(
    join(output, 'resource-graph.json'),
    JSON.stringify(
      {
        id: 'aegis-reference-labs',
        revision,
        resources,
      },
      null,
      2,
    ) + '\n',
  );
  await build({
    absWorkingDir: root,
    stdin: {
      resolveDir: root,
      contents: `import { OfflinePackStore } from '@aegis/browser/offline';
import { attachOfflineWorker } from '@aegis/browser/offline/worker';
const store = new OfflinePackStore({ namespace: 'aegis-reference-labs', baseUrl: self.registration.scope });
attachOfflineWorker(self, store, {
  packs: [{ id: 'aegis-reference-labs', revision: ${JSON.stringify(revision)} }],
  shell: 'index.html',
  onError() {
    void self.clients.matchAll().then(clients => clients.forEach(client => client.postMessage({ type: 'aegis-offline-error' })))
      .catch(() => console.error('AEGIS offline status notification failed'));
  }
});`,
    },
    outfile: join(output, 'worker.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
  });
  writeFileSync(
    join(output, 'build-report.json'),
    JSON.stringify(
      {
        format: 'aegis-reference-build/1',
        base,
        revision,
        inputs: Object.keys(result.metafile.inputs),
        resources: resources.length,
      },
      null,
      2,
    ) + '\n',
  );
  return { directory: output, base, revision, resources: resources.length };
}

if (isMain(import.meta.url)) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') options.outDir = args[++i];
    else if (args[i] === '--base') options.base = args[++i];
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  console.log(JSON.stringify(await buildLabs(options), null, 2));
}
