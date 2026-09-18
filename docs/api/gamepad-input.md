# Browser input and controllers

Import from **`@aegis/render-three/input`**, not the package root. This explicit subpath loads
no Node hosting code or Three renderer and touches no browser globals at import time.
It works with your own canvas, renderer, animation loop and UI. Hardware sampling stays outside
`@aegis/core`; the simulation still receives the existing logical `InputFrame`. Script, replay,
headless operation and fixed-tick semantics are unchanged.

## Standalone controller sampling

```ts
import { createGamepadInput } from '@aegis/render-three/input';

const controller = createGamepadInput({
  bindings: {
    sticks: [
      { axes: [0, 1], x: 'MoveX', y: 'MoveY', deadZone: 0.2, label: 'Left stick' },
      { axes: [2, 3], x: 'AimX', y: 'AimY', label: 'Right stick' },
    ],
    buttons: [
      { button: 0, action: 'Confirm', label: 'A' },
      { button: 1, action: 'Cancel', label: 'B' },
      { button: 7, action: 'Attack', axis: 'Pressure', threshold: 0.5, label: 'RT' },
    ],
  },
});

// Call once each requestAnimationFrame, even if gameplay simulation is paused.
const sample = controller.sample();
// sample.held / pressed / released: logical action names
// sample.axes: { MoveX, MoveY, AimX, AimY, Pressure }
// sample.device / lastActiveDevice / activity / status / armed: prompts and diagnostics
```

This is the **browser Gamepad API's standard mapping**, initially targeting Xbox-style
controllers. It is not native XInput. The browser may hide a connected device until a button
is pressed; release the controls afterward to arm it. A non-standard mapping is reported as
`unsupported-mapping`, never guessed from the device name. An absent API reports `unsupported`;
a permissions-policy `SecurityError` reports `blocked`. Unexpected API errors propagate.
Serve over HTTPS or localhost and permit `gamepad` when embedding in an iframe.

Selection is sticky: the lowest-index connected standard device is selected first and retained
until disconnected/replaced. `index` pins a specific slot. Additional idle controllers cannot
steal input. `getGamepads` can inject an alternate reader for an embedding or an automated test;
real `navigator.getGamepads()` is the default. This is a single-controller adapter, not local
multiplayer routing. Use one explicitly indexed instance per player if needed.

## Binding data

| Binding   | Fields and interpretation                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buttons` | `button` is a standard button index; optional `action`, analog `axis`, `threshold` (default 0.5), `scale`, `label`. Triggers preserve their pressure instead of collapsing to booleans. |
| `sticks`  | `axes: [xIndex, yIndex]`, logical `x`/`y` names, optional `deadZone` (default 0.2), `invertX`, `invertY`, `label`.                                                                      |
| `axes`    | Independent scalar mapping: hardware `axis`, logical `name`, optional `deadZone`, `scale`, `label`. Prefer `sticks` for paired axes.                                                    |

Stick dead zones are radial and rescaled: the dead zone is neutral, the remaining radial
distance occupies the full analog range, and diagonals stay inside a unit disk. Axis values
are bounded to [-1, 1], button values to [0, 1]; missing or non-finite hardware samples are
neutral. Invalid binding configuration throws a descriptive error at creation.
Bindings and labels are available through `controller.bindings` for game-owned prompts.
`activity` advances on meaningful non-neutral changes, not continuously while a stick is held;
`lastActiveDevice` retains provenance when the selected device disconnects.

## Lifecycle, focus and paused UI

`sample()` drains **controller-sample edges**, not simulation edges. Holding a control does
not repeatedly press it. Poll at display rate: a physical tap entirely between two polls cannot
be observed by the browser API. Disconnect emits one release and clears analog state.

The first connection, replacement, reconnection, `clear()` and `resume()` require all bound
controls to return to neutral before rearming. This prevents a held trigger or menu confirmation
from becoming a new gameplay press. `armed` exposes that distinction even when a device is `ready`.
`clear()` drops levels and emits any outstanding releases
on the next sample. `suspend()` returns neutral input; `resume()` enables neutral rearming.
`dispose()` removes owned listeners and permanently stops capture.

By default, blur and document visibility suspend capture and require rearming on return.
`manageFocus: false` lets your host own those transitions. Explicit suspension is separate from
document focus: focusing a window must not resume an explicitly suspended sampler.

**Do not suspend the shared controller just because simulation is paused** if menus still need
it. Keep sampling for UI and gate only delivery to gameplay. On returning to gameplay, clear
the controller and the gameplay buffers together; neutral rearming prevents the UI's held
confirm/attack from leaking into gameplay. Keyboard/mouse sources must likewise be cleared or
rearmed by their owner. Different consumers should not independently call `sample()` and expect
the same edge: sample once and distribute that snapshot.

## Compose devices through the existing tick boundary

```ts
import { createInputBuffer, createLiveInput } from '@aegis/render-three/input';

const packets = createInputBuffer();
const ticks = createLiveInput();

// Your display loop supplies current levels, under stable source IDs:
packets.setSource('keyboard', { held: ['Attack'], axes: { MoveX: 1 } });
packets.setSource('controller', controller.sample());
ticks.submit(packets.take());

// In your fixed-step loop, not your display loop:
const frame = ticks.frameFor(0);
```

The buffer takes **levels** (`held`, `axes`), not already-consumed device edges. Actions are
unioned across owners; releasing the mouse cannot release an action still held on a controller.
Analog contributions add and clamp once, so opposing devices can cancel. Update a source with
empty levels or call `removeSource(id)` to release only that owner.

Source updates derive aggregate press/release edges immediately. `take()` drains them into an
`InputPacket`; `createLiveInput` preserves pending edges until the next tick and consumes them
exactly once across catch-up ticks. Multiple taps of one action before a tick coalesce to one
press/release, as with the existing keyboard path. `clear()` drops all pending input without
rewinding packet sequence numbers. Its next packet carries `reset: true`, which also cancels
impulses already queued in `LiveInput`; `clear({ releaseHeld: true })` additionally emits release
edges. At a synchronous gameplay/UI boundary, clear the tick source immediately too:

```ts
controller.clear();
packets.clear();
ticks.clear();
```

Camera rates are presentation input: integrate a normalized stick by **elapsed seconds exactly
once**, then `packets.addLook(deltaYawDegrees, deltaPitchDegrees)`. Before a catch-up batch call
`ticks.spreadLookOver(numberOfSteps)` to distribute that already-integrated delta. Do not multiply
the delta by elapsed time or step count again. Games with their own camera need not use
`LiveInput` at all; they may read controller axes directly.

## Existing Aegis browser pages

`createInputCollector({ canvas, bindings, pick, onCommand })` composes keyboard, mouse and the
mode's optional `gamepad` profile. Call `poll(elapsedSeconds)` on **every display frame**, then
`take()` when transport/simulation is ready. Both live dev pages and static exports do this,
including while an HTTP frame is in flight. `lastActiveDevice` identifies keyboard, mouse or
gamepad; `gamepad` exposes the latest sampler status/device.

| Mode       | Default standard controller profile                                                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platformer | Left stick or D-pad moves; A jumps. Movement stays analog.                                                                                                                                                     |
| FPS        | Left stick moves; right stick looks (120 degrees/s yaw, 90 pitch); A jumps; RT fires above 0.5. The existing screen/world handedness is preserved. No pointer lock is needed for controller look.              |
| Iso        | Left stick moves a visible screen cursor at up to 500 CSS pixels/s; A clicks once through the **same picker and logical pointer** as the mouse. This orders movement/attack, not direct analog actor movement. |
| Session    | Menu pauses/resumes; View restarts. These actions never enter gameplay.                                                                                                                                        |

Controller look/cursor elapsed time is capped to 0.25 seconds per display to avoid a large
background-tab jump. The cursor clamps to the canvas, is hidden on disconnect/focus loss, and
yields to mouse movement. `onGamepadPointer` allows custom hosts to draw it without requiring the
collector to create DOM. The shipped pages include the cursor and control help.
`onGamepadSample` provides connection, permission and rearm feedback; the shipped diagnostics
show these states instead of silently ignoring an unavailable or blocked API.

Pause transitions clear pending input and rearm the controller. Controller session commands
remain live while paused, but controller gameplay is not queued for resume. Keyboard/mouse
remain available for deliberate paused single-stepping; resume clears their queued impulses.
The dev client clears input when issuing pause/resume, waits for any preceding frame exchange,
and holds new exchanges until the control acknowledgement. Input captured during that transition
is discarded, so a delayed response cannot deliver a paused confirmation after resume.
Restart and focus loss also clear the input boundary. `suspend()`/`resume()` are available to
custom collectors, and `dispose()` detaches listeners. A supplied `gamepad` instance is not
disposed by the collector; its caller retains that ownership.

Automated coverage uses virtual standard devices with real browser collectors and live/static
pages, plus public-import graph and unit tests. It does **not** claim physical Xbox hardware,
Bluetooth/USB driver compatibility, haptics, non-standard layouts, browser menu focus navigation,
aim assistance or universal controller playability for arbitrary game plugins.
