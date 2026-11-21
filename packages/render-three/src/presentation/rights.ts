import { DiagnosticError } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import { isAssetPath, renderDiagnostic, RenderCode } from './diagnostics.js';
import type { PreparedPresentationFile } from './files.js';

export const RELEASE_TARGETS = ['evaluation', 'commercial'] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

export interface AssetReview {
  path: string;
  sha256: string;
  commercial: 'cleared' | 'restricted';
  reviewer: string;
  evidence: string;
}

export interface AssetRights {
  aegis: 'asset-rights/1';
  files: readonly AssetReview[];
}

export type RightsStatus = AssetReview['commercial'] | 'unreviewed' | 'changed';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** Validate the sidecar even for an evaluation build: never silently ignore a malformed review. */
export function parseAssetRights(value: unknown, file?: string): AssetRights {
  const fail = (path: string, message: string): never => {
    throw new DiagnosticError([
      renderDiagnostic(
        RenderCode.Rights,
        path,
        message,
        'Use asset-rights/1 with one path, SHA-256, commercial decision, reviewer and evidence per reviewed file.',
        file,
      ),
    ]);
  };
  if (
    !object(value) ||
    value.aegis !== 'asset-rights/1' ||
    !Array.isArray(value.files) ||
    Object.keys(value).some((key) => !['aegis', 'files'].includes(key))
  )
    return fail('rights', 'Expected an asset-rights/1 document with a files array.');
  const paths = new Set<string>();
  const files = value.files.map((row: unknown, index: number): AssetReview => {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) => !['path', 'sha256', 'commercial', 'reviewer', 'evidence'].includes(key),
      ) ||
      !text(row.path) ||
      !isAssetPath(row.path) ||
      !text(row.sha256) ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      (row.commercial !== 'cleared' && row.commercial !== 'restricted') ||
      !text(row.reviewer) ||
      !text(row.evidence)
    )
      return fail(
        `files[${index}]`,
        'Invalid asset review; a path or a required review field is invalid.',
      );
    if (paths.has(row.path.toLowerCase()))
      return fail(`files[${index}].path`, `Ambiguous duplicate review for "${row.path}".`);
    paths.add(row.path.toLowerCase());
    return {
      path: row.path,
      sha256: row.sha256,
      commercial: row.commercial,
      reviewer: row.reviewer,
      evidence: row.evidence,
    };
  });
  return { aegis: 'asset-rights/1', files };
}

export function reviewFile(
  game: string,
  file: PreparedPresentationFile,
  review: AssetReview | undefined,
): { status: RightsStatus; problem?: Diagnostic } {
  const status =
    file.provenance?.commercialUse === 'restricted'
      ? 'restricted'
      : !review
        ? 'unreviewed'
        : review.sha256 !== file.sha256
          ? 'changed'
          : review.commercial;
  if (status === 'cleared') return { status };
  const provenance = file.provenance;
  return {
    status,
    problem: renderDiagnostic(
      RenderCode.Rights,
      `${game}/${file.path}`,
      `Commercial export blocked: ${game}/${file.path} is ${status}. ` +
        `Provenance: ${provenance ? `${provenance.author}; ${provenance.license}; ${provenance.source}` : 'undeclared'}.` +
        (review ? ` Review: ${review.reviewer}; ${review.evidence}.` : ''),
      status === 'restricted'
        ? 'Keep --release evaluation. A release owner must resolve the documented restriction before commercial use.'
        : 'Keep --release evaluation, or have a release owner verify commercial rights for these exact bytes ' +
            `(${file.sha256}) and record the supporting evidence in the game's asset-rights/1 declaration.`,
    ),
  };
}
