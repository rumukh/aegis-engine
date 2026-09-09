import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PreviewCode, previewDiagnostics, previewError } from './diagnostics.js';
import { DiagnosticError } from '@aegis/core';
import type { AssetPreviewServer } from './server.js';
import { validateCaptureRequest } from './server.js';

/** Resolve only a bounded basename, refusing aliases of any authored source or dependency. */
export function previewOutputPaths(
  server: AssetPreviewServer,
  filename: string,
  revision: number,
): { file: string; sidecar: string } {
  validateCaptureRequest({ filename, revision });
  if (server.outputDir === undefined)
    throw previewError(
      PreviewCode.Output,
      'outputDir',
      'Capture output directory was not explicitly enabled.',
      'Set outputDir when starting the preview, or use --out/--out-dir.',
    );
  const closure = server.current(revision);
  const sources = [
    ...new Set([
      closure.sourcePath,
      closure.sourceRealPath,
      ...closure.prepared.files.map((entry) => entry.source),
    ]),
  ];
  try {
    mkdirSync(server.outputDir, { recursive: true });
    const root = realpathSync(server.outputDir);
    const file = join(root, filename);
    const sidecar = `${file}.preview.json`;
    const sourceStats = sources.map((source) => statSync(source, { bigint: true }));
    for (const target of [file, sidecar]) {
      const targetStat = existsSync(target) ? lstatSync(target, { bigint: true }) : undefined;
      if (
        sources.some((source) => relative(source, target) === '') ||
        (targetStat !== undefined &&
          (targetStat.isSymbolicLink() ||
            !targetStat.isFile() ||
            sourceStats.some(
              (source) =>
                targetStat.ino !== 0n &&
                targetStat.ino === source.ino &&
                targetStat.dev === source.dev,
            )))
      )
        throw previewError(
          PreviewCode.Output,
          'filename',
          'Capture cannot replace or alias a source asset, descriptor, dependency, symlink, or non-file.',
          'Choose a different PNG basename in the explicitly enabled output directory.',
        );
    }
    return { file, sidecar };
  } catch (error) {
    throw new DiagnosticError(previewDiagnostics(error, PreviewCode.Output));
  }
}
