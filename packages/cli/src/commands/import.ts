import { importModelAsset, readImportProvenance } from '@aegis/render-three/asset-import';
import type { Command } from '../command.js';
import { AegisCliError, CliCode } from '../errors.js';
import { json } from '../format.js';
import { flagBool, flagString, requirePositional, resolvePath } from './shared.js';

export const importCommand: Command = {
  name: 'import',
  summary: 'Package a local GLB/glTF and its checked dependencies.',
  usage: [
    'aegis import <model.glb|model.gltf> --id <id> --out-dir <new-directory> --provenance <file.json> [options]',
    '',
    'Copy exact model bytes and the production-checked local dependency closure.',
    'The destination parent must exist; the destination itself must not exist.',
    'No browser, generator, game plugin, rescaling, collider creation or automatic game edits.',
    '',
    '  --id <id>              Stable presentation asset ID.',
    '  --out-dir <directory>  Fresh package destination; never overwritten.',
    '  --provenance <file>    Explicit JSON { author, license, source }; no inferred licensing.',
    '  --dry-run             Validate and report the planned package without writing.',
    '  --json                Versioned report; structured errors on stderr.',
    '',
    'Writes model/<checked files>, asset.presentation.json and import.json (asset-import/1).',
    'GLB/glTF only; no compressed decoder extensions, remote dependencies or generator latents.',
    'Import is not visual approval. Review the packaged descriptor with aegis preview.',
  ].join('\n'),
  flags: { id: 'value', 'out-dir': 'value', provenance: 'value', 'dry-run': 'boolean' },
  formats: {
    reads: ['glTF/2.0', 'provenance-json'],
    writes: ['glTF/2.0', 'presentation/1', 'asset-import/1'],
    stdout: ['text', 'asset-import-result/1'],
  },
  async run({ args, io }) {
    const source = requirePositional(
      args,
      0,
      'model',
      'aegis import <model> --id <id> --out-dir <new-directory> --provenance <file.json>',
    );
    if (args.positionals.length !== 1)
      throw new AegisCliError(CliCode.InvalidFlagValue, 'Import accepts exactly one model.');
    const required = (name: string): string => {
      const value = flagString(args, name);
      if (value === undefined)
        throw new AegisCliError(CliCode.MissingArgument, `Flag --${name} is required.`);
      return value;
    };
    const id = required('id');
    const outDir = resolvePath(io, required('out-dir'));
    const provenance = readImportProvenance(resolvePath(io, required('provenance')));
    const result = importModelAsset({
      source: resolvePath(io, source),
      id,
      outDir,
      provenance,
      dryRun: flagBool(args, 'dry-run'),
    });
    io.out(
      flagBool(args, 'json')
        ? json(result)
        : `${result.status}: ${result.outDir}\n${result.receipt.files.length} asset file(s), ${result.receipt.totalAssetBytes} bytes\nReview asset.presentation.json with aegis preview before game integration.\n`,
    );
    return 0;
  },
};
