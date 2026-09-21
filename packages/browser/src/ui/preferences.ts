import { BrowserServiceError, isRecord } from '../errors.js';

export interface PresentationPreferences {
  locale: string;
  textScale: number;
  reducedMotion: boolean;
  comfort: boolean;
  hideSpoilers: boolean;
  volumes: { narration: number; music: number; effects: number };
}
export type MessageCatalog = Readonly<Record<string, string>>;

export function createMessages(
  catalog: MessageCatalog,
): (key: string, values?: Readonly<Record<string, string>>) => string {
  return (key, values = {}) => {
    if (!Object.hasOwn(catalog, key))
      throw new BrowserServiceError('invalid-data', `Missing localized message key "${key}".`);
    return catalog[key]!.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
      if (!Object.hasOwn(values, name))
        throw new BrowserServiceError(
          'invalid-data',
          `Missing authored message parameter "${name}".`,
        );
      return values[name]!;
    });
  };
}

export function isPresentationPreferences(value: unknown): value is PresentationPreferences {
  if (!isRecord(value) || !isRecord(value.volumes)) return false;
  const volumes = value.volumes;
  return (
    typeof value.locale === 'string' &&
    /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(value.locale) &&
    typeof value.textScale === 'number' &&
    Number.isFinite(value.textScale) &&
    value.textScale >= 1 &&
    value.textScale <= 2 &&
    typeof value.reducedMotion === 'boolean' &&
    typeof value.comfort === 'boolean' &&
    typeof value.hideSpoilers === 'boolean' &&
    ['narration', 'music', 'effects'].every((bus) => {
      const volume = volumes[bus];
      return typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 && volume <= 1;
    })
  );
}

export const CHILD_SAFE_PRESET = Object.freeze({
  targetPixels: 48,
  readingPixels: 24,
  maxTextScale: 2,
  primaryChoices: 3,
  visibilityPause: true,
  manualAdvance: true,
  telemetry: false,
  debugGlobals: false,
  outboundLinks: false,
});

export function applyPresentationPreferences(
  root: HTMLElement,
  preferences: PresentationPreferences,
): void {
  if (!isPresentationPreferences(preferences))
    throw new BrowserServiceError('invalid-data', 'Invalid presentation preferences.');
  root.lang = preferences.locale;
  root.style.setProperty('--aegis-text-scale', String(preferences.textScale));
  root.dataset['reducedMotion'] = String(preferences.reducedMotion);
  root.dataset['comfort'] = String(preferences.comfort);
  root.dataset['hideSpoilers'] = String(preferences.hideSpoilers);
}

/** Scoped, opt-in styles. Readability/contrast are not a claim about arbitrary consumer artwork. */
export const CHILD_SAFE_CSS = `
.aegis-child {
  color: #172333; background: #fffaf0; font-family: system-ui, sans-serif;
  font-size: calc(24px * var(--aegis-text-scale, 1)); line-height: 1.5;
  overflow-wrap: anywhere;
}
.aegis-child *, .aegis-child *::before, .aegis-child *::after { box-sizing: border-box; }
.aegis-child button, .aegis-child input, .aegis-child select {
  min-width: 48px; min-height: 48px; font: inherit; color: inherit;
  background: #ffffff; border: 2px solid #475569; border-radius: 0.3em;
  white-space: normal; max-width: 100%; padding: 0.3em 0.6em;
}
.aegis-child :focus-visible { outline: 3px solid #174da5; outline-offset: 3px; }
.aegis-child nav, .aegis-child [data-choices] { display: flex; flex-wrap: wrap; gap: 0.5em; }
.aegis-child dialog { color: inherit; background: #fffaf0; max-width: 90vw; max-height: 85vh; overflow: auto; }
.aegis-child[data-reduced-motion="true"] *, .aegis-child[data-reduced-motion="true"] *::before,
.aegis-child[data-reduced-motion="true"] *::after { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) {
  .aegis-child *, .aegis-child *::before, .aegis-child *::after { animation: none !important; transition: none !important; }
}`;

export function choicePage<T>(
  choices: readonly T[],
  page: number,
  size = CHILD_SAFE_PRESET.primaryChoices,
): { items: readonly T[]; page: number; pages: number } {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(page) || page < 0)
    throw new BrowserServiceError('invalid-data', 'Choice pagination requires positive bounds.');
  const pages = Math.max(1, Math.ceil(choices.length / size));
  if (page >= pages) throw new BrowserServiceError('invalid-data', 'Choice page is out of range.');
  return { items: choices.slice(page * size, (page + 1) * size), page, pages };
}

/** Call on a candidate release tree before mounting it, and after consumer-owned updates. */
export function assertChildSafeView(root: HTMLElement, baseUrl: string): void {
  if (root.matches('iframe, embed, object') || root.querySelector('iframe, embed, object'))
    throw new BrowserServiceError(
      'invalid-data',
      'Child-safe views must not contain third-party embeds.',
    );
  const origin = new URL(baseUrl).origin;
  for (const element of [root, ...root.querySelectorAll('[href], [action], [formaction]')]) {
    for (const attribute of ['href', 'action', 'formaction']) {
      const target = element.getAttribute(attribute);
      if (target === null) continue;
      const url = new URL(target, baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
        throw new BrowserServiceError(
          'invalid-data',
          'Child-safe views must not contain outbound navigation.',
        );
    }
  }
}
