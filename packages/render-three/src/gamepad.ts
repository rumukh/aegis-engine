/**
 * Browser hardware input, independent of rendering and simulation ticks. Importing this module
 * reads no browser globals; an injected getter also works in a headless host.
 * @packageDocumentation
 */

export interface GamepadButtonBinding {
  button: number;
  action?: string;
  axis?: string;
  /** Inclusive analog threshold in [0, 1], default 0.5. Zero never counts as pressed. */
  threshold?: number;
  /** Analog output multiplier, default 1; the result is clamped to [-1, 1]. */
  scale?: number;
  label?: string;
}

export interface GamepadStickBinding {
  axes: readonly [number, number];
  x: string;
  y: string;
  /** Radial dead zone in [0, 1), default 0.2; the remaining radius maps to [0, 1]. */
  deadZone?: number;
  invertX?: boolean;
  invertY?: boolean;
  label?: string;
}

export interface GamepadAxisBinding {
  axis: number;
  name: string;
  /** Scalar dead zone in [0, 1), default 0.2; the remaining magnitude maps to [0, 1]. */
  deadZone?: number;
  scale?: number;
  label?: string;
}

export interface GamepadBindings {
  buttons?: readonly GamepadButtonBinding[];
  sticks?: readonly GamepadStickBinding[];
  axes?: readonly GamepadAxisBinding[];
}

export interface GamepadDeviceInfo {
  index: number;
  id: string;
  mapping: string;
}

/** The subset of a native Gamepad that sampling needs. */
export interface GamepadDevice extends GamepadDeviceInfo {
  connected: boolean;
  axes: readonly number[];
  buttons: readonly { value: number; pressed: boolean }[];
}

export type GamepadStatus =
  | 'unsupported'
  | 'no-device'
  | 'unsupported-mapping'
  | 'ready'
  | 'suspended'
  | 'disposed'
  | 'blocked';

export interface GamepadSample {
  /** True only after the selected device has passed the neutral interlock and can emit input. */
  readonly armed: boolean;
  held: readonly string[];
  pressed: readonly string[];
  released: readonly string[];
  /** Every bound axis is present, including zero levels after a reset or disconnect. */
  axes: Readonly<Record<string, number>>;
  /** Selected device, or the rejected device for unsupported-mapping. Suspended state is cached. */
  device: GamepadDeviceInfo | null;
  lastActiveDevice: GamepadDeviceInfo | null;
  /**
   * Increments once per sample with a new logical press or a nonzero axis change of at least
   * 0.01 since its last meaningful value. Rest, releases and unchanged holds do not increment it.
   */
  activity: number;
  /** Ready includes waiting for all bound controls to become neutral before arming. */
  status: GamepadStatus;
}

export interface GamepadInput {
  /** A frozen copy: caller mutation cannot bypass eager binding validation. */
  readonly bindings: GamepadBindings;
  sample(): GamepadSample;
  /** Drop levels and queue held-action releases once; require neutral before accepting input. */
  clear(): void;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

function invalid(path: string, requirement: string): never {
  throw new Error(`[aegis] Gamepad input: ${path} ${requirement}.`);
}

function index(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(path, 'must be a non-negative safe integer');
  }
}

function name(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(path, 'must be a non-empty string');
  }
}

function finite(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(path, 'must be a finite number');
  }
}

function deadZone(value: number | undefined, path: string): void {
  if (value === undefined) return;
  finite(value, path);
  if (value < 0 || value >= 1) invalid(path, 'must be in [0, 1)');
}

function validateBindings(bindings: GamepadBindings): GamepadBindings {
  if (bindings === null || typeof bindings !== 'object' || Array.isArray(bindings)) {
    invalid('bindings', 'must be an object');
  }
  for (const kind of ['buttons', 'sticks', 'axes'] as const) {
    const entries = bindings[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) invalid(`bindings.${kind}`, 'must be an array');
    for (const [i, entry] of entries.entries()) {
      const path = `bindings.${kind}[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        invalid(path, 'must be a binding object');
      }
      if (entry.label !== undefined) name(entry.label, `${path}.label`);
    }
  }
  bindings.buttons?.forEach((binding, i) => {
    const path = `bindings.buttons[${i}]`;
    index(binding.button, `${path}.button`);
    if (binding.action === undefined && binding.axis === undefined) {
      invalid(path, 'must declare an action or axis');
    }
    if (binding.action !== undefined) name(binding.action, `${path}.action`);
    if (binding.axis !== undefined) name(binding.axis, `${path}.axis`);
    if (binding.scale !== undefined) finite(binding.scale, `${path}.scale`);
    if (binding.threshold !== undefined) {
      finite(binding.threshold, `${path}.threshold`);
      if (binding.threshold < 0 || binding.threshold > 1) {
        invalid(`${path}.threshold`, 'must be in [0, 1]');
      }
    }
  });
  bindings.sticks?.forEach((binding, i) => {
    const path = `bindings.sticks[${i}]`;
    if (!Array.isArray(binding.axes) || binding.axes.length !== 2) {
      invalid(`${path}.axes`, 'must contain exactly two axis indices');
    }
    index(binding.axes[0], `${path}.axes[0]`);
    index(binding.axes[1], `${path}.axes[1]`);
    name(binding.x, `${path}.x`);
    name(binding.y, `${path}.y`);
    if (binding.x === binding.y) invalid(path, 'must use distinct x and y output names');
    deadZone(binding.deadZone, `${path}.deadZone`);
    for (const key of ['invertX', 'invertY'] as const) {
      if (binding[key] !== undefined && typeof binding[key] !== 'boolean') {
        invalid(`${path}.${key}`, 'must be a boolean');
      }
    }
  });
  bindings.axes?.forEach((binding, i) => {
    const path = `bindings.axes[${i}]`;
    index(binding.axis, `${path}.axis`);
    name(binding.name, `${path}.name`);
    deadZone(binding.deadZone, `${path}.deadZone`);
    if (binding.scale !== undefined) finite(binding.scale, `${path}.scale`);
  });
  return Object.freeze({
    ...(bindings.buttons === undefined
      ? {}
      : {
          buttons: Object.freeze(bindings.buttons.map((binding) => Object.freeze({ ...binding }))),
        }),
    ...(bindings.sticks === undefined
      ? {}
      : {
          sticks: Object.freeze(
            bindings.sticks.map((binding) =>
              Object.freeze({
                ...binding,
                axes: Object.freeze([binding.axes[0], binding.axes[1]] as const),
              }),
            ),
          ),
        }),
    ...(bindings.axes === undefined
      ? {}
      : { axes: Object.freeze(bindings.axes.map((binding) => Object.freeze({ ...binding }))) }),
  });
}

function clamp(value: number, low = -1, high = 1): number {
  const bounded = Math.max(low, Math.min(high, value));
  return bounded === 0 ? 0 : bounded;
}

function hardwareValue(value: unknown, low = -1): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, low) : 0;
}

function info(device: GamepadDeviceInfo): GamepadDeviceInfo {
  return { index: device.index, id: device.id, mapping: device.mapping };
}

function sameDevice(left: GamepadDeviceInfo, right: GamepadDeviceInfo): boolean {
  return left.index === right.index && left.id === right.id && left.mapping === right.mapping;
}

/**
 * Sample one sticky, standard-mapped controller. A pinned index never falls back to another
 * slot. Selection, reconnects, clear and resume all require a neutral sample before input can
 * produce edges. Actions combine by ownership (OR); repeated analog output names sum and clamp.
 *
 * Automatic focus suspension and explicit suspension are independent. Sampling is display-frame
 * work, including while a simulation is paused; this adapter has no simulation clock.
 */
export function createGamepadInput(options: {
  bindings: GamepadBindings;
  index?: number;
  getGamepads?: () => readonly (GamepadDevice | null)[];
  manageFocus?: boolean;
}): GamepadInput {
  if (options === null || typeof options !== 'object') invalid('options', 'must be an object');
  const bindings = validateBindings(options.bindings);
  const pinnedIndex = options.index;
  const getGamepads = options.getGamepads;
  if (pinnedIndex !== undefined) index(pinnedIndex, 'index');
  if (getGamepads !== undefined && typeof getGamepads !== 'function') {
    invalid('getGamepads', 'must be a function');
  }
  if (options.manageFocus !== undefined && typeof options.manageFocus !== 'boolean') {
    invalid('manageFocus', 'must be a boolean');
  }

  const axisNames = new Set<string>();
  for (const binding of bindings.buttons ?? []) {
    if (binding.axis !== undefined) axisNames.add(binding.axis);
  }
  for (const binding of bindings.sticks ?? []) {
    axisNames.add(binding.x);
    axisNames.add(binding.y);
  }
  for (const binding of bindings.axes ?? []) axisNames.add(binding.name);
  const zeroAxes = (): Record<string, number> =>
    Object.fromEntries([...axisNames].map((key) => [key, 0]));

  let selected: GamepadDeviceInfo | null = null;
  let lastActiveDevice: GamepadDeviceInfo | null = null;
  let activity = 0;
  let activityAxes = zeroAxes();
  let held = new Set<string>();
  let axes = zeroAxes();
  const releases = new Set<string>();
  let armed = false;
  let suspended = false;
  let disposed = false;

  const drop = (): void => {
    for (const action of held) releases.add(action);
    held = new Set();
    axes = zeroAxes();
    activityAxes = zeroAxes();
    armed = false;
  };

  const focusWindow =
    options.manageFocus !== false && typeof window !== 'undefined' ? window : undefined;
  const focusDocument =
    options.manageFocus !== false && typeof document !== 'undefined' ? document : undefined;
  let focused = focusDocument?.hasFocus?.() ?? true;
  let focusSuspended = false;
  const syncFocus = (): void => {
    const next =
      !focused || focusDocument?.hidden === true || focusDocument?.visibilityState === 'hidden';
    if (next !== focusSuspended) {
      focusSuspended = next;
      drop();
    }
  };
  const onBlur = (): void => {
    focused = false;
    syncFocus();
  };
  const onFocus = (): void => {
    focused = true;
    syncFocus();
  };
  syncFocus();
  focusWindow?.addEventListener('blur', onBlur);
  focusWindow?.addEventListener('focus', onFocus);
  focusDocument?.addEventListener('visibilitychange', syncFocus);

  const snapshot = (
    status: GamepadStatus,
    device: GamepadDeviceInfo | null = selected,
    pressed: readonly string[] = [],
  ): GamepadSample => {
    const released = [...releases];
    releases.clear();
    return {
      armed,
      held: [...held],
      pressed,
      released,
      axes: { ...axes },
      device: device === null ? null : info(device),
      lastActiveDevice: lastActiveDevice === null ? null : info(lastActiveDevice),
      activity,
      status,
    };
  };

  const readControls = (device: GamepadDevice) => {
    const nextHeld = new Set<string>();
    const nextAxes = zeroAxes();
    let neutral = true;
    const addAxis = (key: string, value: number): void => {
      nextAxes[key] = (nextAxes[key] ?? 0) + clamp(value);
    };
    for (const binding of bindings.buttons ?? []) {
      const value = hardwareValue(device.buttons?.[binding.button]?.value, 0);
      if (binding.action !== undefined && value > 0 && value >= (binding.threshold ?? 0.5)) {
        nextHeld.add(binding.action);
        neutral = false;
      }
      if (binding.axis !== undefined) {
        addAxis(binding.axis, value * (binding.scale ?? 1));
        if (value !== 0) neutral = false;
      }
    }
    for (const binding of bindings.sticks ?? []) {
      const x = hardwareValue(device.axes?.[binding.axes[0]]);
      const y = hardwareValue(device.axes?.[binding.axes[1]]);
      const radius = Math.hypot(x, y);
      const zone = binding.deadZone ?? 0.2;
      if (radius <= zone) continue;
      neutral = false;
      const magnitude = (Math.min(radius, 1) - zone) / (1 - zone);
      addAxis(binding.x, (x / radius) * magnitude * (binding.invertX ? -1 : 1));
      addAxis(binding.y, (y / radius) * magnitude * (binding.invertY ? -1 : 1));
    }
    for (const binding of bindings.axes ?? []) {
      const value = hardwareValue(device.axes?.[binding.axis]);
      const zone = binding.deadZone ?? 0.2;
      if (Math.abs(value) <= zone) continue;
      neutral = false;
      addAxis(
        binding.name,
        Math.sign(value) * ((Math.abs(value) - zone) / (1 - zone)) * (binding.scale ?? 1),
      );
    }
    for (const key of axisNames) nextAxes[key] = clamp(nextAxes[key] ?? 0);
    return { held: nextHeld, axes: nextAxes, neutral };
  };

  return {
    bindings,
    sample(): GamepadSample {
      if (disposed) return snapshot('disposed');
      syncFocus();
      if (suspended || focusSuspended) return snapshot('suspended');

      let devices: readonly (GamepadDevice | null)[] | undefined;
      try {
        if (getGamepads !== undefined) devices = getGamepads();
        else if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
          devices = navigator.getGamepads();
        }
      } catch (error) {
        drop();
        selected = null;
        if (
          error !== null &&
          typeof error === 'object' &&
          'name' in error &&
          error.name === 'SecurityError'
        ) {
          return snapshot('blocked');
        }
        throw error;
      }
      if (devices === undefined) {
        drop();
        selected = null;
        return snapshot('unsupported');
      }

      let candidate: GamepadDevice | undefined;
      let rejected: GamepadDevice | undefined;
      for (const device of devices) {
        if (
          device == null ||
          !device.connected ||
          !Number.isSafeInteger(device.index) ||
          device.index < 0 ||
          (pinnedIndex !== undefined && device.index !== pinnedIndex)
        ) {
          continue;
        }
        if (device.mapping !== 'standard') {
          if (rejected === undefined || device.index < rejected.index) rejected = device;
        } else if (selected !== null && sameDevice(selected, device)) {
          candidate = device;
          break;
        } else if (candidate === undefined || device.index < candidate.index) {
          candidate = device;
        }
      }
      if (candidate === undefined) {
        drop();
        selected = null;
        return snapshot(
          rejected === undefined ? 'no-device' : 'unsupported-mapping',
          rejected === undefined ? null : rejected,
        );
      }
      if (selected === null || !sameDevice(selected, candidate)) {
        drop();
        selected = info(candidate);
      }
      const controls = readControls(candidate);
      if (!armed) {
        armed = controls.neutral;
        return snapshot('ready');
      }

      const pressed = [...controls.held].filter((action) => !held.has(action));
      for (const action of held) {
        if (!controls.held.has(action)) releases.add(action);
      }
      let active = pressed.length !== 0;
      for (const key of axisNames) {
        const value = controls.axes[key] ?? 0;
        if (value === 0) activityAxes[key] = 0;
        else if (Math.abs(value - (activityAxes[key] ?? 0)) >= 0.01) active = true;
      }
      if (active) {
        activity++;
        activityAxes = { ...controls.axes };
        lastActiveDevice = info(selected);
      }
      held = controls.held;
      axes = controls.axes;
      return snapshot('ready', selected, pressed);
    },
    clear(): void {
      if (!disposed) drop();
    },
    suspend(): void {
      if (disposed) return;
      suspended = true;
      drop();
    },
    resume(): void {
      if (disposed) return;
      suspended = false;
      drop();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      drop();
      selected = null;
      focusWindow?.removeEventListener('blur', onBlur);
      focusWindow?.removeEventListener('focus', onFocus);
      focusDocument?.removeEventListener('visibilitychange', syncFocus);
    },
  };
}
