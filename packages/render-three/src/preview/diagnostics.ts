import { DiagnosticError } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';

export const PreviewCode = {
  Input: 'AEG-PREVIEW-0001',
  Selection: 'AEG-PREVIEW-0002',
  Settings: 'AEG-PREVIEW-0003',
  Revision: 'AEG-PREVIEW-0004',
  Load: 'AEG-PREVIEW-0005',
  Output: 'AEG-PREVIEW-0006',
  Access: 'AEG-PREVIEW-0007',
  Browser: 'AEG-PREVIEW-0008',
} as const;

export function previewError(
  code: string,
  path: string,
  message: string,
  fix: string,
): DiagnosticError {
  return new DiagnosticError([{ code, severity: 'error', location: { path }, message, fix }]);
}

export function previewDiagnostics(
  error: unknown,
  code: string = PreviewCode.Load,
): readonly Diagnostic[] {
  if (error instanceof AggregateError)
    return error.errors.flatMap((entry: unknown) => previewDiagnostics(entry, code));
  return error instanceof DiagnosticError
    ? error.diagnostics
    : [
        {
          code,
          severity: 'error',
          location: { path: 'preview' },
          message: error instanceof Error ? error.message : String(error),
          fix: 'Correct the reported problem and reload the asset preview. No game needs to be started.',
        },
      ];
}

export function record(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw previewError(
      PreviewCode.Settings,
      path,
      'Expected an object.',
      `Supply ${path} as a JSON object.`,
    );
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      throw previewError(
        PreviewCode.Settings,
        `${path}.${key}`,
        `Unknown field "${key}".`,
        `Use only: ${keys.join(', ')}.`,
      );
  return value as Record<string, unknown>;
}
