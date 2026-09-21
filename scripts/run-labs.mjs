import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain, repositoryRoot } from './sdk-tools.mjs';

export async function runLabs(root = repositoryRoot) {
  const temporary = mkdtempSync(join(tmpdir(), 'aegis-headless-labs-'));
  try {
    const output = join(temporary, 'rules.mjs');
    await build({
      absWorkingDir: root,
      stdin: {
        contents: `export { loadKitchenContent, runKitchenTrace } from './poc/turn-kitchen-lab/model.ts';
export { loadStoryContent, runStoryTrace } from './poc/storybook-lab/model.ts';`,
        resolveDir: root,
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'es2022',
    });
    const rules = await import(pathToFileURL(output).href);
    return {
      story: await rules.runStoryTrace(
        rules.loadStoryContent(
          readFileSync(join(root, 'poc', 'storybook-lab', 'content.json'), 'utf8'),
        ),
      ),
      kitchen: await rules.runKitchenTrace(
        rules.loadKitchenContent(
          readFileSync(join(root, 'poc', 'turn-kitchen-lab', 'balance.json'), 'utf8'),
        ),
      ),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) console.log(JSON.stringify(await runLabs(), null, 2));
