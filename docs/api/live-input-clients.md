# Live browser input streams

The live server still owns one shared single-player simulation per game. Multiple pages may
observe it, but only one page controls gameplay input at a time. This is not multiplayer,
input blending or a separate simulation for each viewer. Static exports remain independent
per-page simulations and do not use the live broker.

A live page sends `FrameRequest.client` with:

```json
{
  "id": "opaque-page-identity",
  "claim": true,
  "generation": 0
}
```

`input.seq` is monotonic **within that page**, not globally across viewers. The identity is
created once per page load using browser cryptographic randomness. A new page therefore
does not wait for its sequence counter to catch an older idle page.

`claim` is emitted only for fresh gameplay intent: a bound key press, captured mouse motion,
canvas click or newly active controller input. Held levels, neutral polls, releases, repeated
key events and focused UI-control interactions do not reclaim ownership. Taking control clears
the previous controller's held levels and pending impulses before accepting the claiming
packet. The claiming input is not discarded. Inactive viewers' neutral/reset packets cannot
erase the controller's state.

The last observed restart `generation` is included with every named stream; it is `null` only
before the initial exchange. Uninitialized or old-generation input cannot drive a newly
restarted world. Restart preserves the simulation's pause state, clears input ownership and
requires fresh gameplay intent. Each viewer also owns its event cursor, so an idle page cannot
consume another page's HUD or audio cues.

`FrameResponse.inputStatus` reports `role` (`controlling` or `observing`), `accepted`,
`reason` (`accepted`, `observing`, `stale` or `generation`) and the page's `lastSeq`.
`lastSeq` is the highest **seen** sequence, including rejected packets, not an input-delivery
or simulation-consumption receipt.
The visible input hint reports observation, lost focus, pause and mouse-capture failures.
`aegis.presentation().input` exposes capture and live transport state for diagnostics.
Pointer-lock promise rejections and legacy `pointerlockerror` events are surfaced explicitly;
the engine does not silently switch to a different mouse-look scheme.

An opt-in loss ending uses the collector's gameplay-only block, not full input suspension:
R and the controller restart command remain available while movement/look/action packets stay
neutral. Capture diagnostics report `gameplayBlocked`; restarting rearms sources without carrying
held controls into the new run. Explicitly bound Control keys themselves are supported, but
Ctrl+letter/browser shortcuts and focused form controls remain excluded. A game should not
advertise Ctrl-held movement unless it separately supports that browser interaction policy.

The host tracks at most 32 recent named pages per game. Inactive records expire after 60 seconds,
except the one record identifying the retained input source (so its duplicates cannot reapply
pending impulses). Capacity overflow is HTTP 429 with an explicit explanation. Owner heartbeats expire
after 2 seconds without an accepted owner packet, releasing held input at the next host
exchange. Already accepted turns, taps, release edges and the latest pointer sample remain in the
existing bounded aggregate until a simulation tick consumes them. There is no per-packet retry
queue. Turns retain the existing fixed-step catch-up sharing; edges/clicks are consumed once.
Same-page fresh reacquisition preserves that aggregate; it does not resurrect expired held
movement. A reset/focus-loss packet from that source still clears pending input after its lease
expires. A different source taking control, a generation restart, and existing pause/context
resets also cancel pending input. Unrelated observers cannot cancel it.

Reconnection after expiry requires fresh intent, not replayed held state. These clocks
belong to the browser/server transport, never authoritative simulation systems.

## Synchronization and failed delivery

`aegis.sync()` waits for an exchange collected after the call. With fresh gameplay input it
requires an accepted response for that packet in the same input context. Definite rejection,
missing acceptance feedback, context cancellation or an ambiguous transport failure rejects
the barrier instead of claiming success on a later neutral poll. Delivery failure remains
visible and subsequent barriers reject until an explicit input-context reset (such as focus
loss or restart). New hardware input can still be submitted; a new sequence is **never** used
to replay the failed packet. Passive observers with no fresh input can synchronize snapshots
without claiming control and can wait for recovery from a failed neutral exchange.

An HTTP-200 response whose body aborts does not prove the server discarded the request:
input may be pending or already consumed. The client retains the actual exchange error and
deadline diagnostics, even if focus loss or restart also occurred. A successful response
cancelled by a proven input-context reset rejects its barrier without inventing a transport
failure. The request deadline remains 2000 ms. Drawable frames render before
collecting and starting their next exchange; bootstrap/history discovery can exchange before
a world is drawable. An older in-flight request can still overlap a later draw, so ordering
alone is not a delivery guarantee.

Invalid client identities, claim/generation fields and non-safe input sequence numbers receive
HTTP 400 rather than being silently accepted. Sequence and duplicate rejection remain per stream.
The metadata-free API retains its single ordered legacy stream; while a named controller is
active, a legacy packet cannot silently replace it and receives explicit observing feedback.
Legacy ordering remains independent of the host's internal sequence translation.

Opening a viewer, taking control, receiving feedback and consuming presentation events never
reset or mutate world state directly. Accepted logical input still passes through the existing
fixed-tick `LiveInput` boundary.
