/**
 * Browser-safe hardware input, independent of the renderer and Node hosting.
 * Import from `@aegis/render-three/input`, not the package's Node-oriented root.
 * @packageDocumentation
 */
export { createGamepadInput } from './gamepad.js';
export type {
  GamepadInput,
  GamepadBindings,
  GamepadButtonBinding,
  GamepadStickBinding,
  GamepadAxisBinding,
  GamepadDevice,
  GamepadDeviceInfo,
  GamepadSample,
  GamepadStatus,
} from './gamepad.js';
export { createInputBuffer } from './input-buffer.js';
export type { InputBuffer, InputLevels } from './input-buffer.js';
export { createLiveInput } from './live-input.js';
export type { InputPacket, LiveInput } from './live-input.js';
export { createInputCollector } from './client/input.js';
export type {
  InputCollector,
  InputCollectorOptions,
  InputDevice,
  SessionCommand,
} from './client/input.js';
export { BINDINGS, SESSION_CONTROLS, CONTROLLER_SESSION_CONTROLS } from './bindings.js';
export type {
  ModeBindings,
  ControllerProfile,
  ActionBinding,
  AxisBinding,
  ControlHelp,
} from './bindings.js';
