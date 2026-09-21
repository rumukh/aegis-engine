import { BrowserServiceError, requireId } from '../errors.js';

export type PlacementCheck = { ok: true } | { ok: false; messageKey: string };
export interface PlacementOptions {
  validate(itemId: string, slotId: string): PlacementCheck;
  commit(itemId: string, slotId: string): void | Promise<void>;
  onChange(state: { selected?: string; busy: boolean; messageKey?: string }): void;
  onError(error: unknown): void;
}

export function createPlacement(options: PlacementOptions) {
  let selected: string | undefined;
  let busy = false;
  let generation = 0;
  const cancellation = new Set<() => void>();
  const publish = (messageKey?: string): void =>
    options.onChange({ selected, busy, ...(messageKey ? { messageKey } : {}) });
  const cancel = (): void => {
    generation++;
    selected = undefined;
    for (const listener of cancellation) listener();
    publish();
  };
  return {
    selected: (): string | undefined => selected,
    cancel,
    onCancel(listener: () => void): () => void {
      cancellation.add(listener);
      return () => {
        cancellation.delete(listener);
      };
    },
    select(id: string): void {
      requireId(id);
      if (busy) throw new BrowserServiceError('blocked', 'A placement commit is pending.');
      selected = id;
      publish();
    },
    preview(slotId: string): PlacementCheck {
      requireId(slotId);
      if (!selected) return { ok: false, messageKey: 'aegis.browser.select-item' };
      return options.validate(selected, slotId);
    },
    async place(slotId: string): Promise<boolean> {
      requireId(slotId);
      if (busy) return false;
      if (!selected) {
        publish('aegis.browser.select-item');
        return false;
      }
      const item = selected;
      const check = options.validate(item, slotId);
      if (!check.ok) {
        publish(check.messageKey);
        return false;
      }
      const token = generation;
      busy = true;
      publish();
      try {
        await options.commit(item, slotId);
        if (generation === token) selected = undefined;
        return true;
      } catch (cause) {
        options.onError(cause);
        return false;
      } finally {
        busy = false;
        publish();
      }
    },
  };
}
export type PlacementController = ReturnType<typeof createPlacement>;

/** Consume touch/pen taps and drags once; native click remains the keyboard/mouse route. */
export function bindPlacementItem(
  button: HTMLButtonElement,
  itemId: string,
  placement: PlacementController,
  options: {
    slotAt(clientX: number, clientY: number): string | undefined;
    onError(error: unknown): void;
  },
): () => void {
  requireId(itemId);
  const listeners = new AbortController();
  const signal = listeners.signal;
  let pointer: { id: number; x: number; y: number; dragging: boolean } | undefined;
  let suppressClick = false;
  const originalTouchAction = button.style.touchAction;
  const originalTouchPriority = button.style.getPropertyPriority('touch-action');
  // The browser chooses pan/zoom policy at contact, before pointermove can begin a drag.
  button.style.touchAction = 'pinch-zoom';
  const finish = (releaseCapture = true): void => {
    const id = pointer?.id;
    pointer = undefined;
    if (releaseCapture && id !== undefined && button.hasPointerCapture(id))
      button.releasePointerCapture(id);
  };
  const cancel = (): void => {
    finish();
    suppressClick = true;
    placement.cancel();
  };
  const unsubscribe = placement.onCancel(() => {
    finish();
    suppressClick = true;
  });
  button.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.isPrimary || event.button !== 0 || button.disabled) return;
      suppressClick = false;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      button.setPointerCapture(event.pointerId);
    },
    { signal },
  );
  button.addEventListener(
    'pointermove',
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (
        !pointer.dragging &&
        Math.abs(event.clientX - pointer.x) + Math.abs(event.clientY - pointer.y) >= 8
      ) {
        try {
          placement.select(itemId);
          pointer.dragging = true;
          button.setPointerCapture(event.pointerId);
        } catch (cause) {
          cancel();
          options.onError(cause);
          return;
        }
      }
    },
    { signal },
  );
  button.addEventListener(
    'pointerup',
    (event) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      const dragged = pointer.dragging;
      finish(false);
      if (!dragged) {
        if (event.pointerType === 'touch' || event.pointerType === 'pen') {
          suppressClick = true;
          try {
            placement.select(itemId);
          } catch (cause) {
            options.onError(cause);
          }
        }
        return;
      }
      suppressClick = true;
      const slot = options.slotAt(event.clientX, event.clientY);
      if (slot) void placement.place(slot).catch(options.onError);
      else placement.cancel();
    },
    { signal },
  );
  button.addEventListener(
    'click',
    (event) => {
      if (event.detail !== 0 && suppressClick) {
        return;
      }
      try {
        placement.select(itemId);
      } catch (cause) {
        options.onError(cause);
      }
    },
    { signal },
  );
  button.addEventListener('pointercancel', cancel, { signal });
  button.addEventListener(
    'lostpointercapture',
    () => {
      if (pointer) cancel();
    },
    { signal },
  );
  button.ownerDocument.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') cancel();
      if (event.repeat && event.target === button && (event.key === 'Enter' || event.key === ' '))
        event.preventDefault();
    },
    { signal },
  );
  button.ownerDocument.defaultView?.addEventListener('blur', cancel, { signal });
  return () => {
    listeners.abort();
    unsubscribe();
    cancel();
    button.style.setProperty('touch-action', originalTouchAction, originalTouchPriority);
  };
}

export function bindPlacementSlot(
  button: HTMLButtonElement,
  slotId: string,
  placement: PlacementController,
  onError: (error: unknown) => void,
): () => void {
  requireId(slotId);
  const listeners = new AbortController();
  const signal = listeners.signal;
  let pointer: { id: number; x: number; y: number } | undefined;
  let suppressPointerClick = false;
  const activate = (): void => {
    void placement.place(slotId).catch(onError);
  };
  const cancel = (): void => {
    pointer = undefined;
    suppressPointerClick = true;
  };
  const unsubscribe = placement.onCancel(cancel);
  button.addEventListener(
    'pointerdown',
    (event) => {
      suppressPointerClick = false;
      if (
        event.isPrimary &&
        event.button === 0 &&
        !button.disabled &&
        (event.pointerType === 'touch' || event.pointerType === 'pen')
      )
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    { signal },
  );
  button.addEventListener(
    'pointerup',
    (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const at = pointer;
      pointer = undefined;
      suppressPointerClick = true;
      if (Math.abs(event.clientX - at.x) + Math.abs(event.clientY - at.y) < 8) activate();
    },
    { signal },
  );
  button.addEventListener('pointercancel', cancel, { signal });
  button.addEventListener(
    'click',
    (event) => {
      if (event.detail !== 0 && suppressPointerClick) return;
      activate();
    },
    { signal },
  );
  return () => {
    listeners.abort();
    unsubscribe();
  };
}
