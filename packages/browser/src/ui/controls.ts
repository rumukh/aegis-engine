import { BrowserServiceError } from '../errors.js';
import type { Hotspot } from './coordinates.js';

export interface ActionButtonOptions {
  document: Document;
  label: string;
  command(): void | Promise<void>;
  onError(error: unknown): void;
}

/** Native click is the ONLY activation path: browsers unify pointer, Enter and Space. */
export function createActionButton(options: ActionButtonOptions): HTMLButtonElement {
  const button = options.document.createElement('button');
  button.type = 'button';
  button.textContent = options.label;
  let running = false;
  button.addEventListener('keydown', (event) => {
    if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
  });
  button.addEventListener('click', () => {
    if (running || button.disabled) return;
    running = true;
    button.setAttribute('aria-busy', 'true');
    const finish = (): void => {
      running = false;
      button.removeAttribute('aria-busy');
    };
    try {
      Promise.resolve(options.command()).then(finish, (cause: unknown) => {
        finish();
        options.onError(cause);
      });
    } catch (cause) {
      finish();
      options.onError(cause);
    }
  });
  return button;
}

export function createHotspotList(
  options: Omit<ActionButtonOptions, 'label' | 'command'> & {
    hotspots: readonly Hotspot[];
    message(key: string): string;
    activate(id: string): void | Promise<void>;
    label: string;
  },
): HTMLElement {
  const nav = options.document.createElement('nav');
  nav.setAttribute('aria-label', options.label);
  for (const item of options.hotspots)
    nav.append(
      createActionButton({
        ...options,
        label: options.message(item.labelKey),
        command: () => options.activate(item.id),
      }),
    );
  return nav;
}

export interface FocusBookmark {
  restore(fallback?: HTMLElement): void;
}
export function rememberFocus(document: Document): FocusBookmark {
  const previous = document.activeElement;
  return {
    restore(fallback): void {
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[inert]'))
        previous.focus();
      else fallback?.focus();
    },
  };
}

export function openDialog(
  dialog: HTMLDialogElement,
  initial?: HTMLElement,
  fallback?: HTMLElement,
): () => void {
  if (dialog.open) throw new BrowserServiceError('blocked', 'Dialog is already open.');
  const bookmark = rememberFocus(dialog.ownerDocument);
  const restore = (): void => bookmark.restore(fallback);
  dialog.addEventListener('close', restore, { once: true });
  dialog.showModal();
  initial?.focus();
  return () => {
    if (dialog.open) dialog.close();
  };
}

/** Replace, do not hide, the old private tree; clear captions/audio outside it too. */
export function replaceProjection(
  root: HTMLElement,
  render: (document: Document) => Node,
  options: {
    stopAudio(): void;
    clearAnnouncements(): void;
    cancelInput(): void;
    focus?: () => HTMLElement | undefined;
  },
): void {
  const bookmark = rememberFocus(root.ownerDocument);
  options.stopAudio();
  options.clearAnnouncements();
  options.cancelInput();
  root.replaceChildren();
  root.append(render(root.ownerDocument));
  const target = options.focus?.();
  if (target) target.focus();
  else bookmark.restore(root);
}

export function bindVisibilityPause(
  document: Document,
  pause: (reason: string) => void,
  resume: (reason: string) => void,
): () => void {
  const update = (): void => {
    if (document.hidden) pause('visibility');
    else resume('visibility');
  };
  document.addEventListener('visibilitychange', update);
  update();
  return () => document.removeEventListener('visibilitychange', update);
}
