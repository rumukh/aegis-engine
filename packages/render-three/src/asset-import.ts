/** Node-only, generator-independent packaging of the production glTF dependency closure. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { DiagnosticError } from '@aegis/core';
import { preparePresentation, readPreparedPresentationFile } from './presentation/files.js';
import { validatePresentation } from './presentation/validate.js';
import type { PresentationManifest, Provenance } from './presentation/schema.js';

export const AssetImportCode = {
  Input: 'AEG-IMPORT-0001',
  Provenance: 'AEG-IMPORT-0002',
  Destination: 'AEG-IMPORT-0003',
  Publication: 'AEG-IMPORT-0004',
} as const;

export interface AssetImportOptions {
  source: string;
  id: string;
  outDir: string;
  provenance: Provenance;
  dryRun?: boolean;
}

export interface AssetImportReceipt {
  aegis: 'asset-import/1';
  id: string;
  source: { file: string; bytes: number; sha256: string };
  provenance: Provenance;
  descriptor: { path: 'asset.presentation.json'; bytes: number; sha256: string };
  files: readonly { source: string; path: string; bytes: number; sha256: string }[];
  totalAssetBytes: number;
  review: 'required; import is not visual approval';
}

export interface AssetImportResult {
  aegis: 'asset-import-result/1';
  status: 'planned' | 'imported';
  outDir: string;
  receipt: AssetImportReceipt;
}

function failure(code: string, path: string, message: string, fix: string): DiagnosticError {
  return new DiagnosticError([{ code, severity: 'error', location: { path }, message, fix }]);
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

/** The explicit declaration is preserved; authorship and legal clearance are not inferred. */
export function parseImportProvenance(value: unknown): Provenance {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('author' in value) ||
    !('license' in value) ||
    !('source' in value) ||
    typeof value.author !== 'string' ||
    typeof value.license !== 'string' ||
    typeof value.source !== 'string' ||
    !value.author.trim() ||
    !value.license.trim() ||
    !value.source.trim() ||
    Object.keys(value).some((key) => !['author', 'license', 'source'].includes(key))
  )
    throw failure(
      AssetImportCode.Provenance,
      'provenance',
      'Import requires exactly { author, license, source }, each a nonempty string.',
      'Declare the asset provenance explicitly. Do not substitute a generation receipt or infer a license.',
    );
  return { author: value.author, license: value.license, source: value.source };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Copy unchanged checked bytes, re-prepare the staged package, then rename the completed
 * directory. A sibling exclusive lock serializes importers targeting the same destination.
 */
export function importModelAsset(options: AssetImportOptions): AssetImportResult {
  let staging: string | undefined;
  let lock: string | undefined;
  let lockFd: number | undefined;
  let result: AssetImportResult | undefined;
  let error: unknown;
  let cleanupError: DiagnosticError | undefined;
  try {
    if (!isAbsolute(options.source) || !isAbsolute(options.outDir))
      throw failure(
        AssetImportCode.Input,
        'paths',
        'The import API requires absolute source and destination paths.',
        'Resolve host paths before calling importModelAsset; the CLI resolves against its working directory.',
      );
    if (!['.glb', '.gltf'].includes(extname(options.source).toLowerCase()))
      throw failure(
        AssetImportCode.Input,
        'source',
        'Import supports only uncompressed glTF 2.0 .glb and .gltf files.',
        'Export a textured GLB/glTF first. PLY, FBX, OBJ and generator latents are not supported.',
      );
    const provenance = parseImportProvenance(options.provenance);
    const sourceRoot = realpathSync(dirname(options.source));
    const sourceName = basename(options.source);
    const original: PresentationManifest = {
      aegis: 'presentation/1',
      assets: [{ id: options.id, kind: 'gltf', src: sourceName, provenance }],
    };
    const prepared = preparePresentation({ assetRoot: sourceRoot, manifest: original });
    const parent = realpathSync(dirname(options.outDir));
    if (!statSync(parent).isDirectory()) throw new Error('Destination parent is not a directory.');
    const destination = join(parent, basename(options.outDir));
    const refuseExisting = (): void => {
      if (exists(destination))
        throw failure(
          AssetImportCode.Destination,
          'outDir',
          `Destination "${options.outDir}" already exists, including a possible source or directory alias.`,
          'Use a fresh revision directory. Import never overwrites an existing file, directory or link.',
        );
    };
    refuseExisting();
    const manifest: PresentationManifest = {
      aegis: 'presentation/1',
      assets: [{ id: options.id, kind: 'gltf', src: `model/${sourceName}`, provenance }],
    };
    const checked = validatePresentation(manifest);
    if (!checked.ok) throw new DiagnosticError(checked.diagnostics);
    const descriptor = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const sourceFile = prepared.files.find((file) => file.path === sourceName);
    if (sourceFile === undefined) throw new Error('Prepared closure omitted the source model.');
    const receipt: AssetImportReceipt = {
      aegis: 'asset-import/1',
      id: options.id,
      source: { file: sourceName, bytes: sourceFile.bytes, sha256: sourceFile.sha256 },
      provenance,
      descriptor: {
        path: 'asset.presentation.json',
        bytes: descriptor.length,
        sha256: sha256(descriptor),
      },
      files: prepared.files.map((file) => ({
        source: file.path,
        path: `model/${file.path}`,
        bytes: file.bytes,
        sha256: file.sha256,
      })),
      totalAssetBytes: prepared.totalBytes,
      review: 'required; import is not visual approval',
    };
    if (options.dryRun === true) {
      result = { aegis: 'asset-import-result/1', status: 'planned', outDir: destination, receipt };
    } else {
      const lockPath = join(parent, `.${basename(destination)}.aegis-import.lock`);
      try {
        lockFd = openSync(lockPath, 'wx', 0o600);
        lock = lockPath;
      } catch (caught) {
        if (errorCode(caught) !== 'EEXIST') throw caught;
        throw failure(
          AssetImportCode.Destination,
          'outDir',
          'Another import reservation exists for this destination.',
          "Wait for the owning importer or inspect a stale reservation; this command never removes another process's lock.",
        );
      }
      writeFileSync(lockFd, JSON.stringify({ pid: process.pid, destination }) + '\n');
      refuseExisting();
      staging = mkdtempSync(join(parent, '.aegis-import-stage-'));
      for (const file of prepared.files) {
        const target = join(staging, 'model', ...file.path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readPreparedPresentationFile(file), { flag: 'wx' });
      }
      writeFileSync(join(staging, receipt.descriptor.path), descriptor, { flag: 'wx' });
      const staged = preparePresentation({ assetRoot: staging, manifest });
      if (
        staged.totalBytes !== prepared.totalBytes ||
        staged.files.length !== receipt.files.length ||
        receipt.files.some((file) => {
          const actual = staged.files.find((entry) => entry.path === file.path);
          return actual?.sha256 !== file.sha256 || actual.bytes !== file.bytes;
        })
      )
        throw new Error('Staged dependency closure differs from the checked source bytes.');
      writeFileSync(join(staging, 'import.json'), JSON.stringify(receipt, null, 2) + '\n', {
        flag: 'wx',
      });
      // Check source freshness again, including the descriptor's exact checked dependency set.
      for (const file of prepared.files) readPreparedPresentationFile(file);
      if (
        realpathSync(dirname(options.outDir)) !== parent ||
        relative(parent, dirname(staging)) !== ''
      )
        throw new Error('Destination parent changed during import.');
      refuseExisting();
      renameSync(staging, destination);
      staging = undefined;
      result = { aegis: 'asset-import-result/1', status: 'imported', outDir: destination, receipt };
    }
  } catch (caught) {
    error =
      caught instanceof DiagnosticError
        ? caught
        : failure(
            AssetImportCode.Publication,
            'import',
            `Asset import failed: ${caught instanceof Error ? caught.message : String(caught)}`,
            'Check source access and use a fresh destination with an existing writable parent. Previous assets are not replaced.',
          );
  } finally {
    const cleanupErrors: string[] = [];
    for (const cleanup of [
      () => {
        if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
      },
      () => {
        if (lockFd !== undefined) closeSync(lockFd);
      },
      () => {
        if (lock !== undefined) unlinkSync(lock);
      },
    ]) {
      try {
        cleanup();
      } catch (caught) {
        cleanupErrors.push(String(caught));
      }
    }
    if (cleanupErrors.length > 0)
      cleanupError = failure(
        AssetImportCode.Publication,
        'cleanup',
        `${error === undefined ? 'Import publication finished' : String(error)}; owned cleanup failed: ${cleanupErrors.join('; ')}`,
        "Inspect the reported owned staging/reservation and destination. Do not delete source assets or another importer's files.",
      );
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (error !== undefined) throw error;
  if (result === undefined) throw new Error('Import produced no result.');
  return result;
}

export function readImportProvenance(path: string): Provenance {
  try {
    if (statSync(path).size > 16_384) throw new Error('Provenance JSON exceeds 16 KiB.');
    return parseImportProvenance(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if (error instanceof DiagnosticError) throw error;
    throw failure(
      AssetImportCode.Provenance,
      'provenance',
      `Cannot read provenance JSON: ${error instanceof Error ? error.message : String(error)}`,
      'Provide a readable UTF-8 JSON file containing { author, license, source }.',
    );
  }
}
