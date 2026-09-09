import { DiagnosticError } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import { AssetPreviewStudio } from '../studio.js';
import { PreviewCode, previewDiagnostics, previewError } from '../diagnostics.js';
import { validatePreviewSettings } from '../settings.js';
import type { PreviewBootConfig } from '../page.js';
import type {
  PreviewCaptureReport,
  PreviewDocument,
  PreviewFrame,
  PreviewSelection,
  PreviewServerState,
  PreviewSettings,
  PreviewStudioState,
} from '../types.js';

export interface AssetPreviewClient {
  state(): PreviewStudioState;
  ready(revision?: number): Promise<PreviewStudioState>;
  reload(selection?: PreviewSelection): Promise<PreviewStudioState>;
  configure(settings: PreviewSettings): PreviewStudioState;
  captureFrame(revision: number, width: number, height: number): PreviewFrame;
  capabilities(): { browser: string; renderer: string };
  dispose(): void;
}

declare global {
  var aegisPreview: AssetPreviewClient | undefined;
  var aegisPreviewFailure: readonly Diagnostic[] | undefined;
}

function element<T extends HTMLElement>(id: string, ctor: { new (...args: never[]): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof ctor)) throw new Error(`Missing asset studio element #${id}.`);
  return node;
}

function options(
  select: HTMLSelectElement,
  entries: readonly { value: string; label: string }[],
  selected: string,
): void {
  const signature = JSON.stringify(entries);
  if (select.dataset.options !== signature) {
    select.replaceChildren(
      ...entries.map((entry) => {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        return option;
      }),
    );
    select.dataset.options = signature;
  }
  select.value = selected;
}

/** Browser entry for the standalone studio; deliberately unrelated to client/boot.ts. */
export function bootAssetPreview(config: PreviewBootConfig): void {
  const status = element('status', HTMLParagraphElement);
  const errorBox = element('error', HTMLPreElement);
  const asset = element('asset', HTMLSelectElement);
  const frame = element('frame', HTMLSelectElement);
  const material = element('material', HTMLSelectElement);
  const clip = element('clip', HTMLSelectElement);
  const scrub = element('scrub', HTMLInputElement);
  const play = element('play', HTMLButtonElement);
  const capture = element('capture', HTMLButtonElement);
  const captureResult = element('capture-result', HTMLParagraphElement);
  let current: PreviewDocument | null = null;
  let accepted = '';
  let loading: Promise<void> = Promise.resolve();
  let disposed = false;
  let events: EventSource | undefined;
  const abort = new AbortController();

  const showError = (error: unknown): void => {
    errorBox.textContent = previewDiagnostics(error)
      .map((entry) => `${entry.code}: ${entry.message}\nFix: ${entry.fix ?? ''}`)
      .join('\n\n');
    errorBox.hidden = false;
  };
  const request = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`./api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aegis-preview-token': config.token },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    const value = await response.json();
    if (!response.ok)
      throw new DiagnosticError(
        value.diagnostics ??
          previewDiagnostics(new Error(`Preview request failed (${response.status}).`)),
      );
    return value as T;
  };
  const update = (state: PreviewStudioState): void => {
    status.textContent =
      `Revision ${state.revision} / ${state.status}` +
      (state.status !== 'ready' && state.lastGoodRevision !== null
        ? ` - showing last-good revision ${state.lastGoodRevision}; current request is NOT ready`
        : '') +
      (state.status === 'ready' && state.loadMs !== null
        ? ` - loaded in ${state.loadMs.toFixed(1)} ms`
        : '');
    errorBox.hidden = state.diagnostics.length === 0;
    if (state.diagnostics.length > 0) showError(new DiagnosticError(state.diagnostics));
    capture.disabled = state.status !== 'ready' || !config.captureEnabled;
    if (state.recipe !== null) {
      for (const key of ['view', 'lighting', 'background', 'shape'] as const)
        (key === 'background'
          ? element(key, HTMLInputElement)
          : element(key, HTMLSelectElement)
        ).value = state.recipe[key];
      element('projection', HTMLSelectElement).value = state.recipe.camera.projection;
    }
    options(
      clip,
      [
        { value: '', label: 'Rest pose' },
        ...(state.stats?.clips ?? []).map((entry) => ({
          value: entry.name,
          label: `${entry.name} (${entry.duration.toFixed(2)} s)`,
        })),
      ],
      state.recipe?.clip ?? '',
    );
    const duration = state.stats?.clips.find(
      (entry) => entry.name === state.recipe?.clip,
    )?.duration;
    scrub.disabled = state.status !== 'ready' || duration === undefined;
    scrub.max = String(duration ?? 1);
    scrub.value = String(state.recipe?.time ?? 0);
    element('time', HTMLOutputElement).value = `${(state.recipe?.time ?? 0).toFixed(3)} s`;
    play.disabled = state.status !== 'ready' || duration === undefined || duration === 0;
    play.textContent = state.playing ? 'Pause clip' : 'Play clip';
    const stats = element('stats', HTMLDListElement);
    stats.replaceChildren();
    if (state.stats !== null) {
      for (const key of ['meshes', 'triangles', 'vertices', 'materials', 'textures'] as const) {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = key;
        dd.textContent = state.stats[key].toLocaleString();
        stats.append(dt, dd);
      }
      element('bounds', HTMLParagraphElement).textContent =
        `Bounds (asset units): ${state.stats.bounds.size.map((n) => n.toFixed(3)).join(' x ')}`;
    }
  };
  let studio: AssetPreviewStudio;
  try {
    studio = new AssetPreviewStudio(element('preview', HTMLCanvasElement), config.settings, update);
  } catch (error) {
    globalThis.aegisPreviewFailure = previewDiagnostics(error, PreviewCode.Browser);
    status.textContent = 'Asset studio could not create its renderer.';
    showError(error);
    return;
  }

  const consume = (state: PreviewServerState): Promise<void> => {
    const key = `${state.revision}:${state.status}`;
    if (key === accepted || state.revision < studio.state().revision) return loading;
    accepted = key;
    if (state.document !== null) {
      current = state.document;
      options(
        asset,
        current.choices.map((entry) => ({
          value: `${entry.kind}:${entry.id}`,
          label: `${entry.kind} / ${entry.id}`,
        })),
        `${current.selection.kind}:${current.selection.id}`,
      );
      const frames =
        current.choices.find(
          (entry) => entry.kind === 'texture' && entry.id === current?.selection.id,
        )?.frames ?? [];
      element('frame-label', HTMLLabelElement).hidden =
        current.selection.kind !== 'texture' || frames.length === 0;
      options(
        frame,
        [
          { value: '', label: 'Entire image' },
          ...frames.map((name) => ({ value: name, label: name })),
        ],
        current.selection.frame ?? '',
      );
      element('material-label', HTMLLabelElement).hidden = current.selection.kind !== 'model';
      options(
        material,
        [
          { value: '', label: 'Model materials (authored)' },
          ...current.choices
            .filter((entry) => entry.kind === 'material')
            .map((entry) => ({ value: entry.id, label: entry.id })),
        ],
        current.selection.material ?? '',
      );
      element('shape-label', HTMLLabelElement).hidden = current.selection.kind !== 'material';
      const undeclared = current.dependencies.some(
        (entry) => entry.provenance.status === 'user-supplied',
      );
      element('provenance', HTMLParagraphElement).textContent = undeclared
        ? 'User-supplied asset. Author, license, and source provenance are not declared.'
        : 'Provenance is declared in the descriptor, not independently verified. Capture recipes preserve it.';
    }
    loading = studio.accept(state);
    return loading;
  };
  const ready = async (revision?: number): Promise<PreviewStudioState> => {
    await loading;
    const state = studio.state();
    if (state.status !== 'ready' || (revision !== undefined && revision !== state.revision))
      throw new DiagnosticError(
        state.diagnostics.length > 0
          ? state.diagnostics
          : previewDiagnostics(
              previewError(
                PreviewCode.Revision,
                'revision',
                `Revision ${state.revision} is ${state.status}, not the requested ready revision.`,
                'Wait for the current source to load or repair it and reload.',
              ),
            ),
      );
    return state;
  };
  const reload = async (selection?: PreviewSelection): Promise<PreviewStudioState> => {
    const state = await request<PreviewServerState>(
      'reload',
      selection === undefined ? {} : { selection },
    );
    await consume(state);
    return ready(state.revision);
  };
  const handle = (work: () => void | Promise<unknown>): void => {
    void Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        if (!disposed) showError(error);
      });
  };
  const on = (id: string, event: string, action: () => void | Promise<unknown>): void => {
    document
      .getElementById(id)
      ?.addEventListener(event, () => handle(action), { signal: abort.signal });
  };
  on('fit', 'click', () => studio.fit());
  on('reload', 'click', () => reload());
  on('asset', 'change', () => {
    const selected = current?.choices.find((entry) => `${entry.kind}:${entry.id}` === asset.value);
    if (selected === undefined) throw new Error('Choose a declared preview asset.');
    return reload({ kind: selected.kind, id: selected.id });
  });
  on('frame', 'change', () => {
    if (current === null) throw new Error('Wait for an asset.');
    return reload({ ...current.selection, frame: frame.value || undefined });
  });
  on('material', 'change', () => {
    if (current === null) throw new Error('Wait for a model.');
    return reload({ ...current.selection, material: material.value || undefined });
  });
  for (const key of ['view', 'projection', 'lighting', 'shape', 'background'] as const)
    on(key, 'change', () => {
      const value = (
        key === 'background' ? element(key, HTMLInputElement) : element(key, HTMLSelectElement)
      ).value;
      studio.configure(validatePreviewSettings({ [key]: value }));
    });
  on('clip', 'change', () => {
    studio.configure({ clip: clip.value || null, time: 0, playing: false });
  });
  on('scrub', 'input', () => {
    studio.configure({ time: Number(scrub.value), playing: false });
  });
  on('play', 'click', () => {
    studio.configure({ playing: !studio.state().playing });
  });
  on('capture', 'click', async () => {
    const state = await ready();
    const recipe = state.recipe!;
    capture.disabled = true;
    captureResult.textContent = 'Capturing this revision...';
    try {
      const report = await request<PreviewCaptureReport>('capture', {
        filename: element('filename', HTMLInputElement).value,
        revision: state.revision,
        width: Number(element('width', HTMLInputElement).value),
        height: Number(element('height', HTMLInputElement).value),
        settings: {
          view: recipe.view,
          projection: recipe.camera.projection,
          camera: {
            position: recipe.camera.position,
            target: recipe.camera.target,
            zoom: recipe.camera.zoom,
            ...(recipe.camera.orthographicHeight === null
              ? {}
              : { orthographicHeight: recipe.camera.orthographicHeight }),
          },
          lighting: recipe.lighting,
          background: recipe.background,
          clip: recipe.clip,
          time: recipe.time,
          playing: false,
          ...(recipe.selection.kind === 'material' ? { shape: recipe.shape } : {}),
        },
      });
      captureResult.textContent = `Saved revision ${report.revision}: ${report.output.path} (+ recipe)`;
    } catch (error) {
      captureResult.textContent = 'Capture failed; no current-revision success was returned.';
      throw error;
    } finally {
      capture.disabled = studio.state().status !== 'ready';
    }
  });
  element('watch', HTMLSpanElement).textContent = config.watch
    ? 'Watching source + selected dependencies'
    : 'Manual reload';
  if (!config.captureEnabled)
    captureResult.textContent =
      'Host writes disabled. Start with --out-dir to enable PNG + recipe capture.';
  const unload = (): void => {
    if (disposed) return;
    disposed = true;
    events?.close();
    abort.abort();
    studio.dispose();
  };
  globalThis.aegisPreview = {
    state: () => studio.state(),
    ready,
    reload,
    configure: (settings) => studio.configure(settings),
    captureFrame: (revision, width, height) => studio.capture(revision, width, height),
    capabilities: () => studio.capabilities(),
    dispose: unload,
  };
  window.addEventListener('pagehide', unload, { once: true, signal: abort.signal });
  loading = fetch('./api/state', { signal: abort.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Preview state responded ${response.status}.`);
      const state = (await response.json()) as PreviewServerState;
      const pending = consume(state);
      events = new EventSource('./api/events');
      events.addEventListener('message', (event: MessageEvent<string>) => {
        handle(() => consume(JSON.parse(event.data) as PreviewServerState));
      });
      events.addEventListener('error', () => {
        if (!disposed) {
          const state = studio.state();
          void consume({
            aegis: 'asset-preview-state/1',
            revision: state.revision,
            status: 'failed',
            lastPreparedRevision: state.lastGoodRevision,
            document: null,
            diagnostics: previewDiagnostics(
              previewError(
                PreviewCode.Access,
                'connection',
                'Lost contact with the preview server.',
                'Restore the server connection; capture is disabled until its current revision is confirmed.',
              ),
            ),
          });
        }
      });
      await pending;
    })
    .catch((error: unknown) => {
      if (!disposed) {
        showError(error);
        globalThis.aegisPreviewFailure = previewDiagnostics(error);
      }
    });
}
