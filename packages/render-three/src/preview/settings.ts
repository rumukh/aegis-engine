import { PREVIEW_LIGHTS, PREVIEW_PROJECTIONS, PREVIEW_SHAPES, PREVIEW_VIEWS } from './types.js';
import type { PreviewSelection, PreviewSettings } from './types.js';
import type { Vec3 } from '../presentation/schema.js';
import { PreviewCode, previewError, record } from './diagnostics.js';

function choice<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  const found = choices.find((entry) => entry === value);
  if (found === undefined)
    throw previewError(
      PreviewCode.Settings,
      path,
      `Unsupported ${path}: ${String(value)}.`,
      `Use one of: ${choices.join(', ')}.`,
    );
  return found;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256)
    throw previewError(
      PreviewCode.Settings,
      path,
      `Expected a nonempty ${path} of at most 256 characters.`,
      'Use an exact declared name.',
    );
  return value;
}

function vector(value: unknown, path: string): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every(
      (item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1e12,
    )
  )
    throw previewError(
      PreviewCode.Settings,
      path,
      'Expected three finite coordinates with magnitude <= 1e12.',
      'Supply [x, y, z] in asset coordinates.',
    );
  return [value[0], value[1], value[2]];
}

export function validateSelection(value: unknown): PreviewSelection {
  const r = record(value, ['kind', 'id', 'material', 'frame'], 'selection');
  const kind = choice(r.kind, ['model', 'texture', 'material'] as const, 'selection.kind');
  if (r.material !== undefined && kind !== 'model')
    throw previewError(
      PreviewCode.Selection,
      'selection.material',
      'Only models accept a material override.',
      'Select a material by kind/id to preview it on a studio sample.',
    );
  if (r.frame !== undefined && kind !== 'texture')
    throw previewError(
      PreviewCode.Selection,
      'selection.frame',
      'Only textures accept an atlas frame.',
      'Select a declared texture and one of its frame names.',
    );
  return {
    kind,
    id: text(r.id, 'selection.id'),
    ...(r.material === undefined ? {} : { material: text(r.material, 'selection.material') }),
    ...(r.frame === undefined ? {} : { frame: text(r.frame, 'selection.frame') }),
  };
}

/** Shared by HTTP, CLI, and the operator controls; unknown fields never silently disappear. */
export function validatePreviewSettings(value: unknown): PreviewSettings {
  const r = record(
    value,
    ['view', 'projection', 'background', 'lighting', 'clip', 'time', 'playing', 'shape', 'camera'],
    'settings',
  );
  const settings: PreviewSettings = {};
  if (r.view !== undefined) settings.view = choice(r.view, PREVIEW_VIEWS, 'view');
  if (r.projection !== undefined)
    settings.projection = choice(r.projection, PREVIEW_PROJECTIONS, 'projection');
  if (r.lighting !== undefined) settings.lighting = choice(r.lighting, PREVIEW_LIGHTS, 'lighting');
  if (r.shape !== undefined) settings.shape = choice(r.shape, PREVIEW_SHAPES, 'shape');
  if (r.background !== undefined) {
    if (typeof r.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(r.background))
      throw previewError(
        PreviewCode.Settings,
        'background',
        'Background must be a six-digit hex color.',
        'Use e.g. "#18212f" or "#ffffff".',
      );
    settings.background = r.background.toLowerCase();
  }
  if (r.clip !== undefined) settings.clip = r.clip === null ? null : text(r.clip, 'clip');
  if (r.time !== undefined) {
    if (typeof r.time !== 'number' || !Number.isFinite(r.time) || r.time < 0)
      throw previewError(
        PreviewCode.Settings,
        'time',
        'Clip time must be finite and nonnegative.',
        'Specify a time in seconds within the selected clip.',
      );
    settings.time = r.time;
  }
  if (r.playing !== undefined) {
    if (typeof r.playing !== 'boolean')
      throw previewError(
        PreviewCode.Settings,
        'playing',
        'playing must be a boolean.',
        'Use true to play the studio clip, or false to sample a fixed time.',
      );
    settings.playing = r.playing;
  }
  if (r.camera !== undefined) {
    const camera = record(r.camera, ['position', 'target', 'zoom', 'orthographicHeight'], 'camera');
    const position = vector(camera.position, 'camera.position');
    const target = vector(camera.target, 'camera.target');
    if (position.every((n, i) => n === target[i]))
      throw previewError(
        PreviewCode.Settings,
        'camera',
        'Camera position and target must differ.',
        'Place the camera outside the subject and point it toward the subject.',
      );
    settings.camera = { position, target };
    for (const key of ['zoom', 'orthographicHeight'] as const) {
      const value = camera[key];
      if (value !== undefined) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e12)
          throw previewError(
            PreviewCode.Settings,
            `camera.${key}`,
            `${key} must be finite and positive, at most 1e12.`,
            'Use the camera values from the previous capture recipe.',
          );
        settings.camera[key] = value;
      }
    }
  }
  return settings;
}

export function captureDimensions(width = 1024, height = 768): { width: number; height: number } {
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n >= 64 && n <= 4096) ||
    width * height > 8_388_608
  )
    throw previewError(
      PreviewCode.Settings,
      'dimensions',
      'Capture dimensions must be integers from 64 to 4096, with at most 8,388,608 pixels.',
      'Use e.g. width 1024 and height 768.',
    );
  return { width, height };
}
