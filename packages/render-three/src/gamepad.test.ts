import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGamepadInput } from './gamepad.js';
import type { GamepadBindings, GamepadDevice, GamepadInput } from './gamepad.js';

interface TestDevice extends GamepadDevice {
  axes: number[];
  buttons: { value: number; pressed: boolean }[];
}

const movement: GamepadBindings = {
  buttons: [{ button: 0, action: 'Jump', label: 'A / Cross' }],
  sticks: [{ axes: [0, 1], x: 'MoveX', y: 'MoveY', label: 'Left stick' }],
};
const zeroMovement = { MoveX: 0, MoveY: 0 };
const inputs: GamepadInput[] = [];

function device(index = 0, id = `Controller ${index}`): TestDevice {
  return {
    index,
    id,
    mapping: 'standard',
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
  };
}

function button(pad: TestDevice, index: number, value: number, pressed = value >= 0.5): void {
  pad.buttons[index] = { value, pressed };
}

function rig(bindings = movement, pad = device(), index?: number, manageFocus = false) {
  const state = { devices: [pad] as (GamepadDevice | null)[] };
  const getter = vi.fn(() => state.devices);
  const input = createGamepadInput({ bindings, index, getGamepads: getter, manageFocus });
  inputs.push(input);
  return { input, pad, state, getter };
}

afterEach(() => {
  for (const input of inputs) input.dispose();
  inputs.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('radial sticks', () => {
  it.each([
    [0, 0, 0, 0],
    [0.2, 0, 0, 0],
    [0.6, 0, 0.5, 0],
    [1, 0, 1, 0],
    [-0.6, 0, -0.5, 0],
    [0, 0.6, 0, 0.5],
    [0, -0.6, 0, -0.5],
    [0.1, 0.1, 0, 0],
    [0.12, 0.16, 0, 0],
    [0.36, 0.48, 0.3, 0.4],
    [-0.36, 0.48, -0.3, 0.4],
    [0.6, 0.8, 0.6, 0.8],
    [0.2, 0.2, 0.07322330470336313, 0.07322330470336313],
    [1, 1, 0.7071067811865475, 0.7071067811865475],
    [-1, -1, -0.7071067811865475, -0.7071067811865475],
  ])('maps (%s, %s) to (%s, %s) with the default dead zone', (x, y, expectedX, expectedY) => {
    const { input, pad } = rig();
    input.sample();
    pad.axes = [x, y];
    const sample = input.sample();
    expect(sample.axes.MoveX).toBeCloseTo(expectedX, 14);
    expect(sample.axes.MoveY).toBeCloseTo(expectedY, 14);
    expect(Math.hypot(sample.axes.MoveX ?? 0, sample.axes.MoveY ?? 0)).toBeLessThanOrEqual(
      1.000000000000001,
    );
  });

  it.each([
    [0, 0.3, 0.4, 0.3, 0.4],
    [0.6, 0.48, 0, 0, 0],
    [0.6, 0.8, 0, 0.5, 0],
    [0.6, 1, 0, 1, 0],
    [0.999, 1, 0, 1, 0],
  ])('honors a custom dead zone %s', (deadZone, x, y, expectedX, expectedY) => {
    const { input, pad } = rig({ sticks: [{ axes: [0, 1], x: 'X', y: 'Y', deadZone }] });
    input.sample();
    pad.axes = [x, y];
    expect(input.sample().axes).toEqual({
      X: expect.closeTo(expectedX, 14),
      Y: expect.closeTo(expectedY, 14),
    });
  });

  it('supports separate pairs, inversion and exact zero instead of negative zero', () => {
    const { input, pad } = rig({
      sticks: [
        { axes: [0, 1], x: 'MoveX', y: 'MoveY', invertY: true },
        { axes: [2, 3], x: 'LookX', y: 'LookY', invertX: true, invertY: true },
      ],
    });
    expect(input.sample().axes).toEqual({ MoveX: 0, MoveY: 0, LookX: 0, LookY: 0 });
    pad.axes = [0.36, 0.48, -0.6, 0];
    const sample = input.sample();
    expect(sample.axes.MoveX).toBeCloseTo(0.3, 14);
    expect(sample.axes.MoveY).toBeCloseTo(-0.4, 14);
    expect(sample.axes.LookX).toBeCloseTo(0.5, 14);
    expect(sample.axes.LookY).toBe(0);
  });
});

describe('buttons and independent axes', () => {
  it('emits one press, persistent held state and one release from button values', () => {
    const { input, pad } = rig();
    expect(input.sample()).toMatchObject({ held: [], pressed: [], released: [], activity: 0 });
    button(pad, 0, 0.49, true);
    expect(input.sample().held).toEqual([]);
    button(pad, 0, 0.5, false);
    expect(input.sample()).toMatchObject({
      held: ['Jump'],
      pressed: ['Jump'],
      released: [],
      activity: 1,
    });
    expect(input.sample()).toMatchObject({
      held: ['Jump'],
      pressed: [],
      released: [],
      activity: 1,
    });
    button(pad, 0, 0);
    expect(input.sample()).toMatchObject({
      held: [],
      pressed: [],
      released: ['Jump'],
      activity: 1,
    });
    expect(input.sample().released).toEqual([]);
  });

  it('preserves analog trigger values independently of a custom action threshold', () => {
    const { input, pad } = rig({
      buttons: [{ button: 7, axis: 'Throttle', action: 'Fire', threshold: 0.75, scale: 0.5 }],
    });
    input.sample();
    button(pad, 7, 0.4, true);
    expect(input.sample()).toMatchObject({ axes: { Throttle: 0.2 }, held: [], pressed: [] });
    button(pad, 7, 0.75, false);
    expect(input.sample()).toMatchObject({
      axes: { Throttle: 0.375 },
      held: ['Fire'],
      pressed: ['Fire'],
    });
    button(pad, 7, 1);
    expect(input.sample()).toMatchObject({ axes: { Throttle: 0.5 }, pressed: [] });
    button(pad, 7, 0.6);
    expect(input.sample()).toMatchObject({ axes: { Throttle: 0.3 }, released: ['Fire'] });
  });

  it.each([0, 1])(
    'accepts threshold endpoint %s without treating neutral as a press',
    (threshold) => {
      const { input, pad } = rig({ buttons: [{ button: 0, action: 'Jump', threshold }] });
      expect(input.sample().held).toEqual([]);
      expect(input.sample().held).toEqual([]);
      button(pad, 0, threshold === 0 ? 0.001 : 1);
      expect(input.sample().pressed).toEqual(['Jump']);
    },
  );

  it('clamps scaled triggers and supports analog-only bindings and signed scales', () => {
    const { input, pad } = rig({
      buttons: [
        { button: 6, axis: 'Brake', scale: -2 },
        { button: 7, axis: 'Accelerate', scale: 2 },
        { button: 0, action: 'Jump', axis: 'Ignored', scale: 0 },
      ],
    });
    input.sample();
    button(pad, 6, 0.8);
    button(pad, 7, 0.7);
    button(pad, 0, 1);
    expect(input.sample()).toMatchObject({
      axes: { Brake: -1, Accelerate: 1, Ignored: 0 },
      held: ['Jump'],
    });
  });

  it('remaps signed scalar axes, applying custom dead zones and scales', () => {
    const { input, pad } = rig({
      axes: [
        { axis: 0, name: 'Default' },
        { axis: 1, name: 'Reversed', deadZone: 0.5, scale: -2 },
        { axis: 2, name: 'Raw', deadZone: 0 },
        { axis: 3, name: 'Muted', scale: 0 },
      ],
    });
    input.sample();
    pad.axes = [-0.6, 0.75, -0.125, 1];
    const sample = input.sample();
    expect(sample.axes.Default).toBeCloseTo(-0.5, 14);
    expect(sample.axes.Reversed).toBe(-1);
    expect(sample.axes.Raw).toBe(-0.125);
    expect(sample.axes.Muted).toBe(0);
    pad.axes = [0.2, -0.5, 0, 0];
    expect(input.sample().axes).toEqual({ Default: 0, Reversed: 0, Raw: 0, Muted: 0 });
  });

  it('keeps an action held until its last button owner releases, including exact handoffs', () => {
    const { input, pad } = rig({
      buttons: [
        { button: 0, action: 'Jump' },
        { button: 1, action: 'Jump' },
        { button: 0, action: 'Jump' },
      ],
    });
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
    button(pad, 1, 1);
    expect(input.sample()).toMatchObject({
      held: ['Jump'],
      pressed: [],
      released: [],
      activity: 1,
    });
    button(pad, 0, 0);
    expect(input.sample()).toMatchObject({ held: ['Jump'], pressed: [], released: [] });
    button(pad, 0, 1);
    button(pad, 1, 0);
    expect(input.sample()).toMatchObject({ held: ['Jump'], pressed: [], released: [] });
    button(pad, 0, 0);
    expect(input.sample().released).toEqual(['Jump']);
  });

  it('allows one physical button to own different logical actions', () => {
    const { input, pad } = rig({
      buttons: [
        { button: 0, action: 'Jump' },
        { button: 0, action: 'Confirm' },
      ],
    });
    input.sample();
    button(pad, 0, 1);
    expect(input.sample()).toMatchObject({
      held: ['Jump', 'Confirm'],
      pressed: ['Jump', 'Confirm'],
      activity: 1,
    });
    input.clear();
    expect(input.sample().released).toEqual(['Jump', 'Confirm']);
    expect(input.sample().released).toEqual([]);
  });

  it('sums repeated axis mappings without cancellation bypassing the neutral interlock', () => {
    const { input, pad } = rig({
      buttons: [
        { button: 6, axis: 'Throttle' },
        { button: 7, axis: 'Throttle', scale: -1 },
      ],
    });
    button(pad, 6, 0.5);
    button(pad, 7, 0.5);
    expect(input.sample().axes).toEqual({ Throttle: 0 });
    button(pad, 7, 0);
    expect(input.sample().axes).toEqual({ Throttle: 0 });
    button(pad, 6, 0);
    input.sample();
    button(pad, 6, 0.7);
    button(pad, 7, 0.2);
    expect(input.sample().axes.Throttle).toBeCloseTo(0.5, 14);
  });

  it('clamps combined analog contributions after summing rather than in binding order', () => {
    const { input, pad } = rig({
      buttons: [
        { button: 0, axis: 'Combined' },
        { button: 1, axis: 'Combined' },
        { button: 2, axis: 'Combined', scale: -1 },
      ],
    });
    input.sample();
    button(pad, 0, 1);
    button(pad, 1, 1);
    button(pad, 2, 1);
    expect(input.sample().axes).toEqual({ Combined: 1 });
  });
});

describe('selection and neutral rearming', () => {
  it('requires all bound controls neutral on the very first connection', () => {
    const { input, pad } = rig();
    button(pad, 0, 1);
    pad.axes[0] = 1;
    expect(input.sample()).toMatchObject({
      status: 'ready',
      armed: false,
      device: { index: 0, id: 'Controller 0', mapping: 'standard' },
      held: [],
      pressed: [],
      axes: zeroMovement,
      activity: 0,
      lastActiveDevice: null,
    });
    button(pad, 0, 0);
    expect(input.sample().axes).toEqual(zeroMovement);
    button(pad, 0, 1);
    pad.axes[0] = 0;
    expect(input.sample().held).toEqual([]);
    button(pad, 0, 0);
    expect(input.sample()).toMatchObject({ armed: true, pressed: [] });
    button(pad, 0, 1);
    expect(input.sample()).toMatchObject({ armed: true, pressed: ['Jump'] });
  });

  it('ignores unbound controls and in-dead-zone drift when arming', () => {
    const { input, pad } = rig();
    button(pad, 12, 1);
    pad.axes = [0.1, 0.1, 1, -1];
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });

  it('selects the lowest standard index, not array position or the most active device', () => {
    const { input, pad, state } = rig(movement, device(5));
    const lower = device(2);
    const unsupported = { ...device(0), mapping: '' };
    state.devices = [pad, null, unsupported, lower];
    expect(input.sample().device?.index).toBe(2);
    button(pad, 0, 1);
    pad.axes[0] = 1;
    expect(input.sample()).toMatchObject({ device: { index: 2 }, held: [], activity: 0 });
    button(lower, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
    const newlyConnected = device(1);
    state.devices.unshift(newlyConnected);
    button(lower, 0, 0);
    expect(input.sample()).toMatchObject({ device: { index: 2 }, released: ['Jump'] });
    button(newlyConnected, 0, 1);
    expect(input.sample()).toMatchObject({ device: { index: 2 }, pressed: [], activity: 1 });
  });

  it('pins an explicit hardware index without falling back to a different slot', () => {
    const { input, pad, state } = rig(movement, device(0), 4);
    expect(input.sample()).toMatchObject({ status: 'no-device', device: null });
    const target = device(4);
    state.devices = [target, pad];
    expect(input.sample().device?.index).toBe(4);
    button(target, 0, 1);
    expect(input.sample().held).toEqual(['Jump']);
    target.connected = false;
    expect(input.sample()).toMatchObject({
      status: 'no-device',
      device: null,
      released: ['Jump'],
      axes: zeroMovement,
    });
    state.devices = [{ ...target, connected: true, mapping: 'vendor' }, pad];
    expect(input.sample()).toMatchObject({
      status: 'unsupported-mapping',
      device: { index: 4, mapping: 'vendor' },
      released: [],
    });
  });

  it.each(['absent', 'disconnected', 'empty'] as const)(
    'releases once when the selected controller is %s, then safely reconnects',
    (cause) => {
      const { input, pad, state } = rig();
      input.sample();
      button(pad, 0, 1);
      pad.axes[0] = 1;
      input.sample();
      if (cause === 'absent') state.devices = [null];
      else if (cause === 'disconnected') pad.connected = false;
      else state.devices = [];
      expect(input.sample()).toMatchObject({
        status: 'no-device',
        device: null,
        held: [],
        pressed: [],
        released: ['Jump'],
        axes: zeroMovement,
        activity: 1,
        lastActiveDevice: { index: 0, id: 'Controller 0' },
      });
      expect(input.sample().released).toEqual([]);
      pad.connected = true;
      state.devices = [pad];
      expect(input.sample()).toMatchObject({ held: [], pressed: [], axes: zeroMovement });
      expect(input.sample().pressed).toEqual([]);
      button(pad, 0, 0);
      pad.axes[0] = 0;
      input.sample();
      button(pad, 0, 1);
      expect(input.sample()).toMatchObject({ pressed: ['Jump'], activity: 2 });
    },
  );

  it('replaces a disconnected selection with another standard controller only after neutral', () => {
    const { input, pad, state } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    const other = device(2, 'Replacement');
    button(other, 0, 1);
    state.devices = [null, other];
    expect(input.sample()).toMatchObject({
      status: 'ready',
      device: { index: 2, id: 'Replacement' },
      lastActiveDevice: { index: 0 },
      released: ['Jump'],
      pressed: [],
      held: [],
    });
    button(other, 0, 0);
    input.sample();
    button(other, 0, 1);
    expect(input.sample()).toMatchObject({
      pressed: ['Jump'],
      activity: 2,
      lastActiveDevice: { index: 2, id: 'Replacement' },
    });
  });

  it('detects same-slot identity replacement but not fresh browser objects for the same device', () => {
    const { input, pad, state } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    state.devices = [{ ...pad }];
    expect(input.sample()).toMatchObject({ held: ['Jump'], pressed: [], released: [] });
    const replacement = device(0, 'Different model');
    button(replacement, 0, 1);
    state.devices = [replacement];
    expect(input.sample()).toMatchObject({
      held: [],
      pressed: [],
      released: ['Jump'],
      device: { id: 'Different model' },
      lastActiveDevice: { id: 'Controller 0' },
    });
    expect(input.sample().released).toEqual([]);
    button(replacement, 0, 0);
    input.sample();
    button(replacement, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });

  it('treats a mapping change as loss of a supported selection', () => {
    const { input, pad } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    pad.mapping = '';
    expect(input.sample()).toMatchObject({
      status: 'unsupported-mapping',
      held: [],
      released: ['Jump'],
      axes: zeroMovement,
    });
    pad.mapping = 'standard';
    expect(input.sample()).toMatchObject({ status: 'ready', pressed: [], held: [] });
    button(pad, 0, 0);
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });
});

describe('lifecycle and activity', () => {
  it('reports the neutral interlock separately from ready device status across lifecycle resets', () => {
    const { input, pad } = rig();
    expect(input.sample()).toMatchObject({ status: 'ready', armed: true });
    button(pad, 0, 1);
    const active = input.sample();
    expect(active).toMatchObject({ armed: true, held: ['Jump'] });
    input.clear();
    expect(input.sample()).toMatchObject({ status: 'ready', armed: false, held: [] });
    expect(active.armed).toBe(true);
    input.suspend();
    expect(input.sample()).toMatchObject({ status: 'suspended', armed: false });
    input.resume();
    expect(input.sample()).toMatchObject({ status: 'ready', armed: false });
    button(pad, 0, 0);
    expect(input.sample()).toMatchObject({ status: 'ready', armed: true });
    pad.connected = false;
    expect(input.sample()).toMatchObject({ status: 'no-device', armed: false });
    pad.connected = true;
    expect(input.sample()).toMatchObject({ status: 'ready', armed: true });
    input.dispose();
    expect(input.sample()).toMatchObject({ status: 'disposed', armed: false });
  });

  it('clear queues real releases exactly once and prevents held controls from rearming', () => {
    const { input, pad } = rig();
    input.sample();
    button(pad, 0, 1);
    pad.axes[0] = 1;
    input.sample();
    input.clear();
    input.clear();
    expect(input.sample()).toMatchObject({
      status: 'ready',
      held: [],
      pressed: [],
      released: ['Jump'],
      axes: zeroMovement,
      activity: 1,
    });
    expect(input.sample().released).toEqual([]);
    button(pad, 0, 0);
    pad.axes[0] = 0;
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });

  it('suspend stops polling; repeated resume still requires a neutral sample', () => {
    const { input, pad, getter } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    getter.mockClear();
    input.suspend();
    input.suspend();
    expect(input.sample()).toMatchObject({
      status: 'suspended',
      released: ['Jump'],
      held: [],
      axes: zeroMovement,
    });
    expect(input.sample().released).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
    input.resume();
    input.resume();
    expect(input.sample()).toMatchObject({ status: 'ready', held: [], pressed: [] });
    button(pad, 0, 0);
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });

  it('preserves queued releases if suspend and resume happen before sampling', () => {
    const { input, pad } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    input.suspend();
    input.resume();
    expect(input.sample()).toMatchObject({ released: ['Jump'], held: [], pressed: [] });
    expect(input.sample().released).toEqual([]);
  });

  it('dispose is final, releases once, and never polls again', () => {
    const { input, pad, getter } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    getter.mockClear();
    input.dispose();
    input.dispose();
    input.resume();
    input.clear();
    input.suspend();
    expect(input.sample()).toMatchObject({
      status: 'disposed',
      device: null,
      held: [],
      pressed: [],
      released: ['Jump'],
      axes: zeroMovement,
      activity: 1,
    });
    expect(input.sample()).toMatchObject({ status: 'disposed', released: [] });
    expect(getter).not.toHaveBeenCalled();
  });

  it('tracks meaningful non-neutral changes rather than rest, jitter, releases or held samples', () => {
    const { input, pad } = rig();
    expect(input.sample()).toMatchObject({ activity: 0, lastActiveDevice: null });
    pad.axes[0] = 0.15;
    expect(input.sample().activity).toBe(0);
    pad.axes[0] = 0.6;
    expect(input.sample().activity).toBe(1);
    for (let i = 0; i < 10; i++) expect(input.sample().activity).toBe(1);
    pad.axes[0] = 0.6001;
    expect(input.sample().activity).toBe(1);
    pad.axes[0] = 0.603;
    expect(input.sample().activity).toBe(1);
    pad.axes[0] = 0.606;
    expect(input.sample().activity).toBe(1);
    pad.axes[0] = 0.61;
    expect(input.sample().activity).toBe(2);
    button(pad, 0, 1);
    expect(input.sample().activity).toBe(3);
    button(pad, 0, 0);
    expect(input.sample().activity).toBe(3);
    pad.axes[0] = 0;
    expect(input.sample()).toMatchObject({
      activity: 3,
      lastActiveDevice: { index: 0, id: 'Controller 0', mapping: 'standard' },
    });
    pad.axes[0] = 0.6;
    expect(input.sample().activity).toBe(4);
  });

  it('samples changing hardware without any simulation, renderer or tick advancement', () => {
    const { input, pad } = rig();
    input.sample();
    button(pad, 0, 1);
    const down = input.sample();
    button(pad, 0, 0);
    const up = input.sample();
    expect(down.pressed).toEqual(['Jump']);
    expect(up.released).toEqual(['Jump']);
    expect(input.sample().released).toEqual([]);
  });

  it('copies bindings and sample data instead of exposing mutable internal state', () => {
    const bindings = {
      buttons: [{ button: 0, action: 'Jump' }],
      sticks: [{ axes: [0, 1] as [number, number], x: 'X', y: 'Y' }],
    };
    const { input, pad } = rig(bindings);
    bindings.buttons[0]!.action = 'Changed';
    bindings.sticks[0]!.axes[0] = 2;
    expect(Object.isFrozen(input.bindings)).toBe(true);
    expect(Object.isFrozen(input.bindings.buttons?.[0])).toBe(true);
    expect(Object.isFrozen(input.bindings.sticks?.[0]?.axes)).toBe(true);
    input.sample();
    button(pad, 0, 1);
    pad.axes[0] = 1;
    const first = input.sample();
    expect(first.held).toEqual(['Jump']);
    expect(first.axes).toEqual({ X: 1, Y: 0 });
    first.device!.id = 'Tampered';
    first.lastActiveDevice!.index = 99;
    (first.axes as Record<string, number>).X = -1;
    (first.held as string[]).push('Tampered');
    expect(input.sample()).toMatchObject({
      held: ['Jump'],
      axes: { X: 1, Y: 0 },
      device: { id: 'Controller 0' },
      lastActiveDevice: { index: 0 },
    });
    input.clear();
    expect(first.pressed).toEqual(['Jump']);
  });
});

describe('hardware boundary and feature detection', () => {
  it('does not access browser globals on import or require navigator when injected', async () => {
    const unavailable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('browser global read');
        },
      },
    );
    vi.stubGlobal('navigator', unavailable);
    vi.stubGlobal('window', unavailable);
    vi.stubGlobal('document', unavailable);
    vi.resetModules();
    const module = await import('./gamepad.js');
    const input = module.createGamepadInput({
      bindings: {},
      getGamepads: () => [],
      manageFocus: false,
    });
    expect(input.sample()).toMatchObject({ status: 'no-device', axes: {} });
    input.dispose();
  });

  it.each([undefined, {}, { getGamepads: undefined }, { getGamepads: false }])(
    'reports an unavailable browser API without throwing',
    (navigatorValue) => {
      vi.stubGlobal('navigator', navigatorValue);
      const input = createGamepadInput({ bindings: movement, manageFocus: false });
      inputs.push(input);
      expect(input.sample()).toEqual({
        status: 'unsupported',
        armed: false,
        device: null,
        lastActiveDevice: null,
        activity: 0,
        held: [],
        pressed: [],
        released: [],
        axes: zeroMovement,
      });
    },
  );

  it('reads navigator lazily with its receiver and re-detects later API availability', () => {
    vi.stubGlobal('navigator', {});
    const input = createGamepadInput({ bindings: movement, manageFocus: false });
    inputs.push(input);
    expect(input.sample().status).toBe('unsupported');
    const pad = device();
    const browser = {
      getGamepads: vi.fn(function (this: unknown) {
        expect(this).toBe(browser);
        return [pad];
      }),
    };
    vi.stubGlobal('navigator', browser);
    expect(browser.getGamepads).not.toHaveBeenCalled();
    expect(input.sample().status).toBe('ready');
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
    vi.stubGlobal('navigator', {});
    expect(input.sample()).toMatchObject({ status: 'unsupported', released: ['Jump'] });
    vi.stubGlobal('navigator', browser);
    expect(input.sample()).toMatchObject({ status: 'ready', held: [], pressed: [] });
  });

  it('structurally accepts native browser Gamepad arrays', () => {
    const nativeGetter: () => readonly (Gamepad | null)[] = () => [];
    const input = createGamepadInput({ bindings: {}, getGamepads: nativeGetter });
    inputs.push(input);
    expect(input.sample().status).toBe('no-device');
  });

  it('does not invent standard mappings for unknown devices', () => {
    const { input, pad } = rig();
    pad.mapping = '';
    button(pad, 0, 1);
    expect(input.sample()).toMatchObject({
      status: 'unsupported-mapping',
      armed: false,
      device: { index: 0, mapping: '' },
      held: [],
      axes: zeroMovement,
      activity: 0,
    });
    pad.connected = false;
    expect(input.sample()).toMatchObject({ status: 'no-device', device: null });
  });

  it('reports SecurityError as blocked, releases safely, and requires neutral after recovery', () => {
    const { input, pad, getter } = rig();
    input.sample();
    button(pad, 0, 1);
    input.sample();
    getter.mockImplementation(() => {
      throw { name: 'SecurityError', message: 'Policy denied access' };
    });
    expect(input.sample()).toMatchObject({
      status: 'blocked',
      armed: false,
      device: null,
      held: [],
      released: ['Jump'],
      axes: zeroMovement,
      lastActiveDevice: { index: 0 },
    });
    expect(input.sample().released).toEqual([]);
    getter.mockImplementation(() => [pad]);
    expect(input.sample()).toMatchObject({ status: 'ready', held: [], pressed: [] });
    button(pad, 0, 0);
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });

  it('also handles a blocked navigator getter without relying on DOMException globals', () => {
    const browser = Object.defineProperty({}, 'getGamepads', {
      get() {
        throw { name: 'SecurityError' };
      },
    });
    vi.stubGlobal('navigator', browser);
    vi.stubGlobal('DOMException', undefined);
    const input = createGamepadInput({ bindings: {}, manageFocus: false });
    inputs.push(input);
    expect(input.sample().status).toBe('blocked');
  });

  it.each([new Error('hardware fault'), { name: 'NotAllowedError' }, 'failure', null])(
    'propagates unexpected getter exceptions unchanged',
    (failure) => {
      const { input, getter } = rig();
      getter.mockImplementation(() => {
        throw failure;
      });
      let caught: unknown = 'not thrown';
      try {
        input.sample();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
    },
  );

  it.each([NaN, Infinity, -Infinity, undefined, null, '1', {}, true])(
    'neutralizes malformed numeric samples (%s), including a true pressed flag',
    (malformed) => {
      const { input, pad } = rig({
        buttons: [{ button: 0, action: 'Jump', axis: 'Trigger' }],
        sticks: [{ axes: [0, 1], x: 'X', y: 'Y' }],
        axes: [{ axis: 2, name: 'Z' }],
      });
      input.sample();
      button(pad, 0, 1);
      pad.axes = [1, 0, 1];
      expect(input.sample().pressed).toEqual(['Jump']);
      button(pad, 0, malformed as number, true);
      pad.axes = [malformed, malformed, malformed] as number[];
      expect(input.sample()).toMatchObject({
        axes: { Trigger: 0, X: 0, Y: 0, Z: 0 },
        held: [],
        released: ['Jump'],
        activity: 1,
      });
    },
  );

  it('treats missing hardware arrays and sparse fields as neutral', () => {
    const { input, pad, state } = rig({
      buttons: [{ button: 20, action: 'Jump', axis: 'Trigger' }],
      sticks: [{ axes: [5, 6], x: 'X', y: 'Y' }],
      axes: [{ axis: 30, name: 'Z' }],
    });
    input.sample();
    const partial = { index: 0, id: pad.id, mapping: 'standard', connected: true };
    state.devices = [partial as GamepadDevice];
    expect(input.sample()).toMatchObject({ axes: { Trigger: 0, X: 0, Y: 0, Z: 0 }, held: [] });
    state.devices = [
      { ...partial, axes: [], buttons: [{ pressed: true }] } as unknown as GamepadDevice,
    ];
    expect(input.sample().held).toEqual([]);
  });

  it('bounds finite out-of-range hardware values before normalization and scaling', () => {
    const { input, pad } = rig({
      buttons: [{ button: 0, action: 'Jump', axis: 'Trigger', scale: Number.MAX_VALUE }],
      sticks: [{ axes: [0, 1], x: 'X', y: 'Y' }],
      axes: [{ axis: 2, name: 'Z', scale: Number.MAX_VALUE }],
    });
    input.sample();
    button(pad, 0, 100);
    pad.axes = [200, 0.5, -500];
    const sample = input.sample();
    expect(sample.held).toEqual(['Jump']);
    expect(sample.axes.Trigger).toBe(1);
    expect(sample.axes.Z).toBe(-1);
    expect(sample.axes.X).toBeCloseTo(0.8944271909999159, 14);
    expect(sample.axes.Y).toBeCloseTo(0.4472135954999579, 14);
    button(pad, 0, -100);
    expect(input.sample()).toMatchObject({ held: [], axes: { Trigger: 0 } });
  });

  it('supports arbitrary non-empty logical names without prototype collisions', () => {
    const { input, pad } = rig({
      buttons: [{ button: 0, axis: '__proto__', action: '__proto__' }],
      axes: [
        { axis: 0, name: 'constructor' },
        { axis: 1, name: 'toString' },
      ],
    });
    input.sample();
    button(pad, 0, 1);
    pad.axes = [1, -1];
    const sample = input.sample();
    expect(sample.axes.__proto__).toBe(1);
    expect(sample.axes.constructor).toBe(1);
    expect(sample.axes.toString).toBe(-1);
    expect(sample.held).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(sample.axes)).toBe(Object.prototype);
  });
});

class FocusDocument extends EventTarget {
  hidden = false;
  visibilityState = 'visible';
  focused = true;
  hasFocus(): boolean {
    return this.focused;
  }
  visibility(hidden: boolean): void {
    this.hidden = hidden;
    this.visibilityState = hidden ? 'hidden' : 'visible';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

function browserFocus() {
  const browser = new EventTarget();
  const page = new FocusDocument();
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', page);
  return { browser, page };
}

describe('automatic focus management', () => {
  it('defaults to managing focus and removes exactly its listeners on disposal', () => {
    const { browser, page } = browserFocus();
    const addWindow = vi.spyOn(browser, 'addEventListener');
    const removeWindow = vi.spyOn(browser, 'removeEventListener');
    const addDocument = vi.spyOn(page, 'addEventListener');
    const removeDocument = vi.spyOn(page, 'removeEventListener');
    const pad = device();
    const input = createGamepadInput({ bindings: movement, getGamepads: () => [pad] });
    inputs.push(input);
    input.sample();
    button(pad, 0, 1);
    input.sample();
    browser.dispatchEvent(new Event('blur'));
    expect(input.sample()).toMatchObject({ status: 'suspended', released: ['Jump'] });
    expect(addWindow.mock.calls.map(([type]) => type)).toEqual(['blur', 'focus']);
    expect(addDocument.mock.calls.map(([type]) => type)).toEqual(['visibilitychange']);
    input.dispose();
    input.dispose();
    expect(removeWindow.mock.calls).toEqual(addWindow.mock.calls);
    expect(removeDocument.mock.calls).toEqual(addDocument.mock.calls);
    browser.dispatchEvent(new Event('focus'));
    page.visibility(false);
    expect(input.sample().status).toBe('disposed');
  });

  it('does not rearm a hidden page just because it receives focus or explicit resume', () => {
    const { browser, page } = browserFocus();
    const { input, pad, getter } = rig(movement, device(), undefined, true);
    input.sample();
    button(pad, 0, 1);
    input.sample();
    page.visibility(true);
    browser.dispatchEvent(new Event('blur'));
    browser.dispatchEvent(new Event('focus'));
    input.resume();
    getter.mockClear();
    expect(input.sample()).toMatchObject({ status: 'suspended', released: ['Jump'], held: [] });
    expect(input.sample().released).toEqual([]);
    expect(getter).not.toHaveBeenCalled();
    page.visibility(false);
    expect(input.sample()).toMatchObject({ status: 'ready', held: [], pressed: [] });
    button(pad, 0, 0);
    input.sample();
    button(pad, 0, 1);
    expect(input.sample().pressed).toEqual(['Jump']);
  });

  it('does not resume an unfocused page just because visibility returns', () => {
    const { browser, page } = browserFocus();
    const { input } = rig(movement, device(), undefined, true);
    input.sample();
    browser.dispatchEvent(new Event('blur'));
    page.visibility(true);
    page.visibility(false);
    expect(input.sample().status).toBe('suspended');
    browser.dispatchEvent(new Event('focus'));
    expect(input.sample().status).toBe('ready');
  });

  it('does not allow automatic focus recovery to undo explicit suspension', () => {
    const { browser, page } = browserFocus();
    const { input } = rig(movement, device(), undefined, true);
    input.sample();
    input.suspend();
    browser.dispatchEvent(new Event('blur'));
    page.visibility(true);
    browser.dispatchEvent(new Event('focus'));
    page.visibility(false);
    expect(input.sample().status).toBe('suspended');
    input.resume();
    expect(input.sample().status).toBe('ready');
  });

  it.each(['hidden', 'unfocused'] as const)('starts suspended when the page is %s', (reason) => {
    const { browser, page } = browserFocus();
    if (reason === 'hidden') page.visibility(true);
    else page.focused = false;
    const { input, getter } = rig(movement, device(), undefined, true);
    expect(input.sample().status).toBe('suspended');
    expect(getter).not.toHaveBeenCalled();
    page.focused = true;
    page.visibility(false);
    browser.dispatchEvent(new Event('focus'));
    expect(input.sample().status).toBe('ready');
  });

  it('checks visibility while sampling even if visibilitychange was not delivered', () => {
    const { page } = browserFocus();
    const { input, pad } = rig(movement, device(), undefined, true);
    input.sample();
    button(pad, 0, 1);
    input.sample();
    page.hidden = true;
    expect(input.sample()).toMatchObject({ status: 'suspended', released: ['Jump'] });
    page.hidden = false;
    expect(input.sample()).toMatchObject({ status: 'ready', held: [] });
  });

  it('allows hosts to opt out of all automatic focus state and listeners', () => {
    const { browser, page } = browserFocus();
    page.visibility(true);
    page.focused = false;
    const addWindow = vi.spyOn(browser, 'addEventListener');
    const addDocument = vi.spyOn(page, 'addEventListener');
    const { input, pad } = rig();
    input.sample();
    button(pad, 0, 1);
    browser.dispatchEvent(new Event('blur'));
    expect(input.sample()).toMatchObject({ status: 'ready', pressed: ['Jump'] });
    expect(addWindow).not.toHaveBeenCalled();
    expect(addDocument).not.toHaveBeenCalled();
  });

  it.each(['window', 'document'] as const)('works when only %s is available', (available) => {
    const { browser, page } = browserFocus();
    vi.stubGlobal(available === 'window' ? 'document' : 'window', undefined);
    const { input } = rig(movement, device(), undefined, true);
    expect(input.sample().status).toBe('ready');
    if (available === 'window') browser.dispatchEvent(new Event('blur'));
    else page.visibility(true);
    expect(input.sample().status).toBe('suspended');
  });
});

describe('eager binding validation', () => {
  const invalidBindings: [string, unknown, string][] = [
    ['missing bindings', undefined, 'bindings'],
    ['null bindings', null, 'bindings'],
    ['array bindings', [], 'bindings'],
    ['non-array buttons', { buttons: null }, 'bindings.buttons'],
    ['non-array sticks', { sticks: {} }, 'bindings.sticks'],
    ['non-array axes', { axes: 'axis' }, 'bindings.axes'],
    ['null entry', { buttons: [null] }, 'bindings.buttons[0]'],
    ['missing entry', { buttons: [undefined] }, 'bindings.buttons[0]'],
    ['sparse entry', { buttons: Array(1) }, 'bindings.buttons[0]'],
    ['no button target', { buttons: [{ button: 0 }] }, 'bindings.buttons[0]'],
    ['missing button index', { buttons: [{ action: 'Jump' }] }, '.button'],
    ['negative button', { buttons: [{ button: -1, action: 'Jump' }] }, '.button'],
    ['fractional button', { buttons: [{ button: 0.5, action: 'Jump' }] }, '.button'],
    ['infinite button', { buttons: [{ button: Infinity, action: 'Jump' }] }, '.button'],
    [
      'unsafe button',
      { buttons: [{ button: Number.MAX_SAFE_INTEGER + 1, action: 'Jump' }] },
      '.button',
    ],
    ['empty action', { buttons: [{ button: 0, action: '' }] }, '.action'],
    ['blank axis', { buttons: [{ button: 0, axis: ' \t' }] }, '.axis'],
    ['non-string action', { buttons: [{ button: 0, action: 1 }] }, '.action'],
    ['low threshold', { buttons: [{ button: 0, action: 'Jump', threshold: -0.1 }] }, '.threshold'],
    ['high threshold', { buttons: [{ button: 0, action: 'Jump', threshold: 1.1 }] }, '.threshold'],
    ['NaN threshold', { buttons: [{ button: 0, action: 'Jump', threshold: NaN }] }, '.threshold'],
    ['null threshold', { buttons: [{ button: 0, action: 'Jump', threshold: null }] }, '.threshold'],
    ['infinite button scale', { buttons: [{ button: 0, axis: 'X', scale: Infinity }] }, '.scale'],
    ['non-string label', { buttons: [{ button: 0, action: 'Jump', label: 42 }] }, '.label'],
    ['missing stick axes', { sticks: [{ x: 'X', y: 'Y' }] }, '.axes'],
    ['short stick axes', { sticks: [{ axes: [0], x: 'X', y: 'Y' }] }, '.axes'],
    ['long stick axes', { sticks: [{ axes: [0, 1, 2], x: 'X', y: 'Y' }] }, '.axes'],
    ['negative stick index', { sticks: [{ axes: [-1, 1], x: 'X', y: 'Y' }] }, '.axes[0]'],
    ['NaN stick index', { sticks: [{ axes: [0, NaN], x: 'X', y: 'Y' }] }, '.axes[1]'],
    ['missing stick name', { sticks: [{ axes: [0, 1], x: 'X' }] }, '.y'],
    ['same stick names', { sticks: [{ axes: [0, 1], x: 'X', y: 'X' }] }, 'distinct'],
    [
      'negative dead zone',
      { sticks: [{ axes: [0, 1], x: 'X', y: 'Y', deadZone: -0.2 }] },
      '.deadZone',
    ],
    ['unit dead zone', { sticks: [{ axes: [0, 1], x: 'X', y: 'Y', deadZone: 1 }] }, '.deadZone'],
    [
      'infinite dead zone',
      { sticks: [{ axes: [0, 1], x: 'X', y: 'Y', deadZone: Infinity }] },
      '.deadZone',
    ],
    ['invalid inversion', { sticks: [{ axes: [0, 1], x: 'X', y: 'Y', invertX: 1 }] }, '.invertX'],
    ['string scalar index', { axes: [{ axis: '0', name: 'X' }] }, '.axis'],
    ['blank scalar name', { axes: [{ axis: 0, name: '' }] }, '.name'],
    ['null scalar scale', { axes: [{ axis: 0, name: 'X', scale: null }] }, '.scale'],
    ['NaN scalar scale', { axes: [{ axis: 0, name: 'X', scale: NaN }] }, '.scale'],
    ['string scalar dead zone', { axes: [{ axis: 0, name: 'X', deadZone: '0.2' }] }, '.deadZone'],
    ['large scalar dead zone', { axes: [{ axis: 0, name: 'X', deadZone: 2 }] }, '.deadZone'],
  ];

  it.each(invalidBindings)('rejects %s before polling hardware', (_label, bindings, path) => {
    const getter = vi.fn(() => []);
    expect(() =>
      createGamepadInput({ bindings: bindings as GamepadBindings, getGamepads: getter }),
    ).toThrowError(`[aegis] Gamepad input: ${path.startsWith('bindings') ? path : ''}`);
    expect(() =>
      createGamepadInput({ bindings: bindings as GamepadBindings, getGamepads: getter }),
    ).toThrowError(path);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '0', null])(
    'rejects an invalid pinned index %s',
    (index) => {
      expect(() => createGamepadInput({ bindings: {}, index: index as number })).toThrowError(
        'index must be a non-negative safe integer',
      );
    },
  );

  it('rejects invalid getter and focus options with descriptive errors', () => {
    expect(() =>
      createGamepadInput({ bindings: {}, getGamepads: false as unknown as () => GamepadDevice[] }),
    ).toThrowError('getGamepads must be a function');
    expect(() =>
      createGamepadInput({ bindings: {}, manageFocus: 'yes' as unknown as boolean }),
    ).toThrowError('manageFocus must be a boolean');
  });
});
