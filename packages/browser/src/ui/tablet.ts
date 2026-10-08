import { BrowserServiceError } from '../errors.js';

/** UI-10 landscape tablet profile: landscape only, with a minimum logical viewport. */
export interface ViewportProfile {
  minWidth: number;
  minHeight: number;
  /** Only landscape is supported; portrait shows a rotate prompt. */
  orientation: 'landscape';
}
export const TABLET_PROFILE: Readonly<ViewportProfile> = Object.freeze({
  minWidth: 1024,
  minHeight: 600,
  orientation: 'landscape',
});

export interface ViewportStatus {
  orientation: 'landscape' | 'portrait';
  /** False in portrait or when the landscape viewport is smaller than the profile minimum. */
  fits: boolean;
  /** `rotate` in portrait, `small` when landscape but below the minimum, otherwise `ok`. */
  reason: 'ok' | 'rotate' | 'small';
  width: number;
  height: number;
}

/** Pure classification of a CSS-pixel viewport; square counts as landscape. */
export function evaluateViewport(
  size: { width: number; height: number },
  profile: ViewportProfile = TABLET_PROFILE,
): ViewportStatus {
  const { width, height } = size;
  if (
    ![width, height, profile.minWidth, profile.minHeight].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    profile.minWidth <= 0 ||
    profile.minHeight <= 0
  )
    throw new BrowserServiceError('invalid-data', 'Viewport sizes must be finite and positive.');
  const orientation = width >= height ? 'landscape' : 'portrait';
  const reason =
    orientation === 'portrait'
      ? 'rotate'
      : width < profile.minWidth || height < profile.minHeight
        ? 'small'
        : 'ok';
  return { orientation, fits: reason === 'ok', reason, width, height };
}

/**
 * Keeps `data-orientation`, `data-viewport` (`ok`/`rotate`/`small`) on `root` in sync with the
 * visual viewport, and reports changes. Pair with `TABLET_PROFILE_CSS` and a
 * `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
 */
export function bindViewportProfile(
  root: HTMLElement,
  view: Window,
  onChange?: (status: ViewportStatus) => void,
  profile: ViewportProfile = TABLET_PROFILE,
): () => void {
  let last = '';
  const update = (): void => {
    const visual = view.visualViewport;
    const status = evaluateViewport(
      {
        width: visual?.width ?? view.innerWidth,
        height: visual?.height ?? view.innerHeight,
      },
      profile,
    );
    root.dataset['orientation'] = status.orientation;
    root.dataset['viewport'] = status.reason;
    const key = `${status.reason}:${String(status.width)}x${String(status.height)}`;
    if (key !== last) {
      last = key;
      onChange?.(status);
    }
  };
  update();
  view.addEventListener('resize', update);
  view.addEventListener('orientationchange', update);
  view.visualViewport?.addEventListener('resize', update);
  return () => {
    view.removeEventListener('resize', update);
    view.removeEventListener('orientationchange', update);
    view.visualViewport?.removeEventListener('resize', update);
  };
}

/**
 * Opt-in, zero-specificity styles: safe-area padding on `.aegis-safe-area`, and a full-screen
 * `.aegis-rotate-prompt` that is shown only while `data-viewport="rotate"` is set on an ancestor
 * (while the game root `.aegis-landscape-only` is hidden from interaction and assistive tech
 * through `inert`, which the consumer sets from `bindViewportProfile`'s callback).
 */
export const TABLET_PROFILE_CSS = `
:where(.aegis-safe-area) {
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
    env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}
:where(.aegis-rotate-prompt) { display: none; }
:where([data-viewport="rotate"]) :where(.aegis-rotate-prompt) {
  display: flex; position: fixed; inset: 0; z-index: 2147483000;
  align-items: center; justify-content: center; text-align: center; padding: 2em;
  background: #fffaf0; color: #172333;
}
:where([data-viewport="rotate"]) :where(.aegis-landscape-only) { visibility: hidden; }`;
