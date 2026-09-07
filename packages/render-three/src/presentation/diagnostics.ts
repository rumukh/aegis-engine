import { DiagnosticError } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';

export const RenderCode = {
  Shape: 'AEG-RENDER-0001',
  Reference: 'AEG-RENDER-0002',
  Path: 'AEG-RENDER-0003',
  Asset: 'AEG-RENDER-0004',
  Unsupported: 'AEG-RENDER-0005',
  Budget: 'AEG-RENDER-0006',
} as const;

export function renderDiagnostic(
  code: string,
  path: string,
  message: string,
  fix: string,
  file?: string,
): Diagnostic {
  return {
    code,
    severity: 'error',
    location: { path, ...(file === undefined ? {} : { file }) },
    message,
    fix,
  };
}

export function assetError(id: string, message: string, fix: string): DiagnosticError {
  return new DiagnosticError([
    renderDiagnostic(RenderCode.Asset, `assets[${JSON.stringify(id)}]`, message, fix),
  ]);
}

/** Asset URLs have one portable spelling; decoding cannot turn them into a different path. */
export function isAssetPath(path: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) &&
    path.split('/').every((part) => part !== '.' && part !== '..')
  );
}
