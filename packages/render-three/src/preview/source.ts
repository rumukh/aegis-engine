import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { DiagnosticError } from '@aegis/core';
import { preparePresentation, readPreparedPresentationFile } from '../presentation/files.js';
import type { PreparedPresentation } from '../presentation/files.js';
import { PRESENTATION_LIMITS } from '../presentation/schema.js';
import type { AssetSpec, PresentationManifest } from '../presentation/schema.js';
import { validatePresentation } from '../presentation/validate.js';
import { PreviewCode, previewError } from './diagnostics.js';
import { validateSelection } from './settings.js';
import type {
  PreviewChoice,
  PreviewDocument,
  PreviewProvenance,
  PreviewSelection,
} from './types.js';

export interface PreviewSourceOptions {
  /** A local glTF, GLB, image, or presentation/1 JSON file. Never a scene or module. */
  source: string;
  /** Descriptor asset paths are relative to this directory, or to the descriptor's directory. */
  assetRoot?: string;
  selection?: PreviewSelection;
}

export interface PreparedPreview {
  document: PreviewDocument;
  prepared: PreparedPresentation;
  sourcePath: string;
  sourceRealPath: string;
  assetRoot: string;
}

const UNKNOWN_PROVENANCE: PreviewProvenance = {
  status: 'user-supplied',
  author: null,
  license: null,
  source: null,
};
const DIRECT_ID = 'preview-asset';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readSource(path: string): Buffer {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > PRESENTATION_LIMITS.fileBytes)
      throw new Error(`expected a regular file of at most ${PRESENTATION_LIMITS.fileBytes} bytes`);
    const bytes = readFileSync(path);
    if (bytes.length > PRESENTATION_LIMITS.fileBytes)
      throw new Error('file grew beyond the byte limit');
    return bytes;
  } catch (error) {
    throw previewError(
      PreviewCode.Input,
      'source',
      `Cannot read preview source "${path}": ${error instanceof Error ? error.message : String(error)}`,
      'Supply a readable local .glb, .gltf, .png, .jpg, .webp, .svg, or presentation/1 .json file.',
    );
  }
}

function descriptor(bytes: Buffer, file: string): PresentationManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw previewError(
      PreviewCode.Input,
      'source',
      `Invalid JSON in "${file}".`,
      'Supply a presentation/1 descriptor, not a scene, asset catalog, or JavaScript module.',
    );
  }
  const result = validatePresentation(value, file);
  if (!result.ok || result.value === undefined) throw new DiagnosticError(result.diagnostics);
  return result.value;
}

function inventory(manifest: PresentationManifest): PreviewChoice[] {
  return [
    ...(manifest.assets ?? []).flatMap((asset): PreviewChoice[] =>
      asset.kind === 'audio'
        ? []
        : [
            {
              kind: asset.kind === 'gltf' ? 'model' : 'texture',
              id: asset.id,
              ...(asset.kind === 'texture' ? { frames: Object.keys(asset.frames ?? {}) } : {}),
            },
          ],
    ),
    ...(manifest.materials ?? []).map((material): PreviewChoice => ({
      kind: 'material',
      id: material.id,
    })),
  ];
}

/** Select a load closure, not entities, decorations, HUD, effects, audio, or a game's catalog. */
function selectManifest(
  manifest: PresentationManifest,
  selection: PreviewSelection,
  choices: readonly PreviewChoice[],
): PresentationManifest {
  const selected = choices.find(
    (entry) => entry.kind === selection.kind && entry.id === selection.id,
  );
  const available = choices.map((entry) => `${entry.kind}:${entry.id}`).join(', ') || '(none)';
  if (selected === undefined)
    throw previewError(
      PreviewCode.Selection,
      'selection',
      `No declared ${selection.kind} "${selection.id}".`,
      `Select one of: ${available}.`,
    );
  if (selection.frame !== undefined && !selected.frames?.includes(selection.frame))
    throw previewError(
      PreviewCode.Selection,
      'selection.frame',
      `Unknown atlas frame "${selection.frame}" on "${selection.id}".`,
      `Use one of: ${selected.frames?.join(', ') || '(no declared frames)'}. Omit frame to preview the entire texture.`,
    );
  const materialId = selection.kind === 'material' ? selection.id : selection.material;
  const materials =
    materialId === undefined
      ? []
      : (manifest.materials ?? []).filter((entry) => entry.id === materialId);
  if (materialId !== undefined && materials.length !== 1)
    throw previewError(
      PreviewCode.Selection,
      'selection.material',
      `No declared material "${materialId}".`,
      `Use one of: ${(manifest.materials ?? []).map((entry) => entry.id).join(', ') || '(none)'}.`,
    );
  const ids = new Set(selection.kind === 'material' ? [] : [selection.id]);
  for (const material of materials) {
    for (const id of [
      material.map,
      material.normalMap,
      material.roughnessMap,
      material.metalnessMap,
      material.aoMap,
      material.emissiveMap,
    ])
      if (id !== undefined) ids.add(id);
  }
  const reflections = manifest.environment?.reflections;
  if (reflections !== undefined) ids.add(reflections.texture);
  return {
    aegis: 'presentation/1',
    assets: (manifest.assets ?? []).filter((asset) => ids.has(asset.id)),
    materials,
    ...(manifest.pipeline === undefined ? {} : { pipeline: manifest.pipeline }),
    ...(manifest.quality === undefined ? {} : { quality: manifest.quality }),
    ...(reflections === undefined ? {} : { environment: { reflections } }),
  };
}

/** The production preflight remains the authority for every byte, including glTF dependencies. */
export function prepareAssetPreview(options: PreviewSourceOptions, revision = 1): PreparedPreview {
  const started = performance.now();
  if (typeof options.source !== 'string' || options.source.trim() === '')
    throw previewError(
      PreviewCode.Input,
      'source',
      'A local asset path is required.',
      'Pass the asset file directly; no scene or plugin is needed.',
    );
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw previewError(
      PreviewCode.Revision,
      'revision',
      'Revision must be a positive integer.',
      'Use the revision returned by the preview server.',
    );
  const requested = resolve(options.source);
  const bytes = readSource(requested);
  const sourcePath = realpathSync(requested);
  const extension = extname(sourcePath).toLowerCase();
  const isDescriptor = extension === '.json';
  let manifest: PresentationManifest;
  if (isDescriptor) {
    manifest = descriptor(bytes, basename(sourcePath));
  } else {
    if (!['.glb', '.gltf', '.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(extension))
      throw previewError(
        PreviewCode.Input,
        'source',
        `Unsupported preview format "${extension || '(no extension)'}".`,
        'Export uncompressed glTF 2.0 (.gltf/.glb), PNG, JPEG, WebP, SVG, or use a presentation/1 JSON descriptor.',
      );
    if (options.assetRoot !== undefined)
      throw previewError(
        PreviewCode.Input,
        'assetRoot',
        'Direct assets use their own directory as the local closure root.',
        'Omit assetRoot; use it only for a presentation/1 descriptor.',
      );
    const asset: AssetSpec = {
      id: DIRECT_ID,
      kind: ['.glb', '.gltf'].includes(extension) ? 'gltf' : 'texture',
      src: basename(sourcePath),
      // The production schema requires text. These are explicit absences, not ownership claims.
      provenance: {
        author: 'Not declared (user supplied)',
        license: 'Not declared',
        source: 'Local user-supplied asset; provenance not declared',
      },
    };
    manifest = { aegis: 'presentation/1', assets: [asset] };
  }
  const choices = inventory(manifest);
  let selection =
    options.selection === undefined ? undefined : validateSelection(options.selection);
  if (selection === undefined) {
    if (choices.length !== 1)
      throw previewError(
        PreviewCode.Selection,
        'selection',
        `The descriptor offers ${choices.length} preview choices; choose one explicitly.`,
        `Use --model <id>, --texture <id>, or --material <id>. Available: ${choices.map((entry) => `${entry.kind}:${entry.id}`).join(', ') || '(none)'}.`,
      );
    const only = choices[0]!;
    selection = { kind: only.kind, id: only.id };
  }
  if (!isDescriptor && selection.id !== DIRECT_ID)
    throw previewError(
      PreviewCode.Selection,
      'selection',
      'Direct assets have the stable preview ID "preview-asset".',
      'Omit selection flags for a direct asset, or use id "preview-asset".',
    );
  if (options.assetRoot !== undefined && !isAbsolute(options.assetRoot))
    throw previewError(
      PreviewCode.Input,
      'assetRoot',
      'The API assetRoot must be absolute.',
      'Resolve the descriptor asset directory before starting the preview.',
    );
  const assetRoot = options.assetRoot ?? dirname(sourcePath);
  const prepared = preparePresentation({
    manifest: selectManifest(manifest, selection, choices),
    assetRoot,
  });
  const sourceSha = sha256(bytes);
  const dependencies = prepared.files.map((file) => ({
    path: file.path,
    bytes: file.bytes,
    sha256: file.sha256,
    provenance:
      isDescriptor && file.provenance !== undefined
        ? { status: 'declared' as const, value: file.provenance }
        : UNKNOWN_PROVENANCE,
  }));
  const fingerprint = sha256(
    JSON.stringify({
      source: sourceSha,
      dependencies: dependencies.map(({ path, sha256 }) => ({ path, sha256 })),
    }),
  );
  const result: PreparedPreview = {
    sourcePath: requested,
    sourceRealPath: sourcePath,
    assetRoot,
    prepared,
    document: {
      revision,
      fingerprint,
      source: {
        name: basename(sourcePath),
        format: isDescriptor ? 'presentation/1' : 'direct',
        bytes: bytes.length,
        sha256: sourceSha,
      },
      dependencies,
      selection,
      choices,
      presentation: {
        manifest: prepared.manifest,
        baseUrl: `./assets/r${revision}/`,
        files: prepared.files.map((file) => file.path),
      },
      prepareMs: performance.now() - started,
    },
  };
  assertPreviewFresh(result);
  result.document.prepareMs = performance.now() - started;
  return result;
}

export function assertPreviewFresh(preview: PreparedPreview): void {
  const bytes = readSource(preview.sourcePath);
  if (
    realpathSync(preview.sourcePath) !== preview.sourceRealPath ||
    sha256(bytes) !== preview.document.source.sha256
  )
    throw previewError(
      PreviewCode.Revision,
      'source',
      'The source changed after this revision was prepared.',
      'Reload and capture the new revision; the last-good frame is not the current source.',
    );
  for (const file of preview.prepared.files) {
    let resolved: string;
    try {
      resolved = realpathSync(join(preview.assetRoot, ...file.path.split('/')));
    } catch {
      throw previewError(
        PreviewCode.Revision,
        'dependencies',
        `Dependency "${file.path}" no longer resolves under the prepared asset root.`,
        'Restore or re-export the local closure and reload before capturing.',
      );
    }
    if (resolved !== file.source)
      throw previewError(
        PreviewCode.Revision,
        'dependencies',
        `Dependency "${file.path}" was replaced or its symlink target changed.`,
        'Re-preflight the new local closure; a previously checked target is not the current source.',
      );
    readPreparedPresentationFile(file);
  }
}
