# Opt-in cinematic presentation

`presentation/1` can opt into a bounded WebGL presentation pipeline. Omitting `pipeline`
preserves the existing direct-render defaults. This is a presentation adapter, not a new
simulation mode: lights, animation, HUD and audio read the mirrored world and never write it.

```json
{
  "aegis": "presentation/1",
  "quality": "high",
  "pipeline": {
    "toneMapping": "aces",
    "exposure": 1,
    "saturation": 0.95,
    "bloom": { "strength": 0.15, "radius": 0.3, "threshold": 1 },
    "ambientOcclusion": { "radius": 4, "minDistance": 0.002, "maxDistance": 0.03 }
  }
}
```

The pipeline renders linear HDR world color, applies screen-space ambient occlusion, clears
depth for the existing camera foreground pass, then applies bloom and saturation. One final
output pass applies ACES and sRGB. The foreground retains self-depth and does not inherit
world occlusion or receive a second tone map. Bloom is an optional highlight effect, not a
substitute for lighting. SSAO uses 16 samples; it is screen-space, not global illumination.
The existing linear distance fog remains distance fog, **not volumetric lighting**.

## Quality and measurements

| Tier     | Maximum backing pixels  | Shadow-map cap | AO/bloom | Global audio voices |
| -------- | ----------------------- | -------------- | -------- | ------------------- |
| low      | 921,600 (1280 x 720)    | 512            | disabled | 8                   |
| standard | 2,073,600 (1920 x 1080) | 1024           | authored | 16                  |
| high     | 3,686,400 (2560 x 1440) | 1024           | authored | 24                  |
| photo    | 8,294,400 (3840 x 2160) | 2048           | authored | 32                  |

Pixel caps apply to the cinematic path, including device pixel ratio. The viewport aspect
ratio is retained; a tall viewport uses the same area budget, not a forced 16:9 crop.
The previous low/standard DPR rules remain unchanged without a pipeline. High/photo require
a pipeline declaration. MSAA samples are 0/2/2/4 respectively; photo is not a 60 fps promise.

`aegis.presentation().pipeline` reports the actual render-target dimensions, pixel count,
budget, enabled passes, sample count and output transform count. Live `aegis.timings()`
draw calls/triangles include the whole composer, shadows and foreground, not just the last
fullscreen draw. CPU render submission time is **not GPU time**. Frame intervals include
browser pacing and shared-machine load; measure the real game, resolution and graphics device
before claiming a frame-rate target.

The browser driver defaults to software WebGL for CI. `launchBrowser({ graphics: 'hardware' })`
opts into the browser's hardware backend for measurement. Always record the actual WebGL
vendor/renderer; a requested hardware backend is not evidence that one was used. Do not run
uncapped animation-frame flags to manufacture a favorable frame-rate measurement.

## Practical lights and reflections

`environment.spots` accepts up to eight spots, with at most four shadow-casting lights in the
combined scene. Begin with one flashlight and one shadowed practical and measure before adding
more. Existing combined point-light limit remains eight. Example:

```json
{
  "id": "flashlight",
  "anchor": "camera",
  "color": "#dce8ee",
  "intensity": 80,
  "position": [0.18, -0.1, 0],
  "target": [0.18, -0.1, -8],
  "angle": 26,
  "penumbra": 0.55,
  "distance": 20,
  "shadow": { "mapSize": 1024, "bias": -0.0001, "normalBias": 0.015 },
  "enabledWhen": {
    "entity": "player",
    "component": "Equipment",
    "field": "flashlight",
    "equals": true
  }
}
```

Positions/targets use renderer coordinates. Camera anchors transform both through the camera's
world matrix (local -Z is forward); entity anchors translate by the named Transform's rendered
position. Unspecified anchors are world-space. `angle` is the cone **half-angle in degrees**.
Intensity is three.js spot intensity in candela; default decay is inverse-square (`2`).
Use distances and authored material values coherently, not indiscriminate ambient brightness.
Shadow map size is clamped by quality. Visible opaque/cutout world meshes cast and receive
shadows on this opt-in path; transparent surfaces do not cast. Foreground light copies do not
cast a second set of world shadows.

`environment.reflections: { texture: "station-probe", intensity: 0.3 }` refers to a declared
equirectangular texture. The browser creates and owns a PMREM, disposing it on host replacement
or preview reload. It borrows, never disposes, the source asset. An LDR PNG/JPEG is an LDR
reflection source, not true HDR, realtime reflections or an environment capture. Both reflections
and shadowed spots require an explicit pipeline.

## PBR maps and file closure

Standard materials support `map`, `normalMap`, `roughnessMap`, `metalnessMap`, `aoMap` and
`emissiveMap`. All values are declared texture IDs. Three.js uses roughness G, metalness B and
AO R, so a packed ORM texture can serve all three. `repeat` applies to every referenced map.
`normalScale` defaults to 1, `aoIntensity` to 1 and `envMapIntensity` to 1.

Scalar PBR maps must declare `colorSpace: "linear"`; cinematic normal maps must also declare
linear sampling. Base/emissive color textures use sRGB. Existing legacy normal sampling is not
silently changed. glTF's own PBR material support remains available without manifest overrides.

No new dependency or increased asset allowance is required: 32 MiB/file and 64 MiB total remain
the preflight limits. All new texture references participate in validation and the same prepared
file inventory used by dev serving, static export and asset previews. Missing files are errors,
not fallback materials.

Native glTF loads within one library share decoded pixel `Source` objects for the same resolved
external image URI. Texture wrappers keep independent color space, UV transforms and sampler
settings; three.js decides whether their GPU storage settings are compatible. Embedded images,
different resolved paths and injected custom decoders are not conflated. No process-global cache
is enabled. Reload/disposal releases cached and retired images with their owning library.
Logical texture counts are not GPU residency measurements; even a decoded pixel-size estimate
does not include other applications, render targets or driver allocations.

## Scalar state, looping clips and HUD

A `StateField` is `{ entity, component, field }`. `field` is a dot-separated own-property
path, never an expression. A `StateCondition` adds `equals` (boolean, finite number or string).
Missing entities/components/fields, non-scalars and mismatched equality types are explicit
diagnostics. Initialize referenced state before presentation mounts.

Spots use `enabledWhen`; decorations use `visibleWhen`. Model visuals may add:

```json
{
  "kind": "model",
  "mesh": "actor",
  "stateClips": [
    {
      "when": {
        "entity": "actor",
        "component": "ActorState",
        "field": "mode",
        "equals": "walking"
      },
      "clip": "Walk",
      "timeScale": 1
    }
  ]
}
```

The first matching entry selects a native-time looping clip. A selected clip/rate change restarts its
presentation clock; `timeScale: 0` holds its start pose. Existing event clip effects override
the loop for their duration, then return to the selected state. Without a match, the existing
`animations`/`clip` selection remains. Static instanced objects cannot animate. No fake velocity
or physics component is required solely to select presentation animation.

`hud.bindings` may map `objective`, `prompt`, `subtitle`, `subtitleUntil` and `status` to
StateFields. All are strings except `subtitleUntil`, an expiry tick. A nonempty live state
subtitle takes precedence over transient audio cue captions. State subtitles with no expiry
persist until changed. Prompts and captions remain readable without audio.

`ui.layout: "cinematic"` opts into compact chrome: current objective, contextual prompt and
subtitles remain visible; full health/progress/step details and session controls are available
in native, keyboard-accessible disclosure controls. A sound error opens the session controls
automatically. Loading/reconnection/errors and run outcomes are never hidden by this layout.
Opening Status reveals its objective steps even in short viewports; the standard layout keeps
its existing responsive treatment.
Omitting the field preserves the existing PoC chrome.

### Optional loss ending

`ui.lossEnding` opts into an unmistakable end screen driven by the existing
`hud.loseEvents`. At least one loss event is required. For example:

```json
{
  "title": "YOU WERE CAUGHT",
  "message": "The responder caught you. Restart from the docking airlock.",
  "fadeSeconds": 1
}
```

The first authoritative loss opens a native modal dialog, releases pointer lock, focuses its
visible Restart button and blocks gameplay input. Only the backdrop fades; the title, message,
errors and button remain opaque and readable. Fade duration defaults to one second and is
bounded to 0–2 seconds. Reduced motion dims immediately. The camera remains upright and unchanged;
no simulation pause, AI, health, collision or state-hash change is made by the presentation.

The dialog persists across frames and repeated loss events; Escape does not dismiss it. Fresh
R, controller View, Enter, Space or a click can restart. Gameplay input is cleared without disabling
the restart command. Held input at death cannot automatically activate Restart; controllers must
return to neutral before rearming. After the new generation's world is observed, the dialog and
fade disappear, the canvas regains focus, and gameplay capture is re-enabled with neutral rearm.
The existing session pause state is preserved. Mouse-look requires the next trusted canvas click
if pointer lock was released; the capture hint makes this explicit.

Reloading a live page whose authoritative event history already contains a loss restores the
ending, without replaying historical audio. Restart clears run-local outcome state. Wins and
omitted `lossEnding` keep their existing behavior. Connection, restart and audio errors are also
reported within the modal instead of being hidden behind its backdrop.

The stable DOM IDs are `loss-ending`, `loss-shade`, `loss-title`, `loss-message`,
`loss-restart` and `loss-error`. `aegis.presentation().ending` reports
`{ active, phase, reducedMotion, fadeSeconds }`; phase is `hidden`, `fading`, `shown` or
`restarting`. Input diagnostics expose `capture.gameplayBlocked` separately from pause/focus.
Custom `PresentationHost` consumers enabling this option must wire `onGameplayBlocked` to
their input collector's `setGameplayBlocked`; the standard live/static hosts already do.

### Optional win cutscene

`ui.winEnding` opts into a presentation-only animated glTF set triggered by `hud.winEvent`.
It does not change the authoritative world, its camera, input history or victory conditions.
The live and static clients use the same player and preloaded asset inventory. For example:

```json
{
  "model": "evacuation-ending",
  "clip": "Departure",
  "camera": { "eye": "ending-eye", "target": "ending-target", "fov": 50 },
  "title": "CLEAR OF NULL MERIDIAN",
  "message": "The crew archive is safe.",
  "fadeSeconds": 1.5,
  "captions": [
    { "startSeconds": 0, "endSeconds": 3.6, "text": "Hatch sealing." },
    { "startSeconds": 4, "endSeconds": 8.5, "text": "Separation confirmed." }
  ],
  "cues": [{ "atSeconds": 4, "event": "presentation.evacuation.separated" }]
}
```

`model` must reference a declared glTF asset. `clip` must uniquely name a 1-120 second animation.
The animated eye/target node names must each occur exactly once and stay apart. They drive a
separate perspective camera (FOV 20-90 degrees, default 50), with a 0.05-2000 unit depth range.
The set has a neutral hemispheric fill and warm directional key, borrowing the game's reflection
map without taking ownership. It uses the existing quality/postprocessing pipeline, not another
renderer or simulation. Models and dependencies count toward the normal encoded asset budget.

`captions` are ordered, non-overlapping intervals within the clip. `cues` are ordered, uniquely
named `presentation.*` events with matching `audio.cues` entries; these go only to browser audio,
never to the world event bus, replay or HUD mission history. Times are local presentation seconds,
not simulation ticks. At most 32 captions and 32 cues are allowed. The final black fade defaults
to 1.5 seconds and accepts 0-3 seconds, bounded by the clip. Invalid clips, nodes and timelines
fail presentation readiness visibly, rather than quietly showing a success screen.

The modal releases pointer lock and blocks gameplay while retaining the restart command and
neutral-rearm contract. It provides Skip / Escape, local Pause, Mute and an eventual Play again
button and catalog link. The clock holds during either local or session pause and while the
document is hidden. Reduced motion skips directly to the persistent completion screen.
Skipped, muted, locked or obsolete audio cues are never caught up; pausing stops active speech
instead of resuming halfway through the line. Captions remain readable without sound.
Repeated events do not replay the cutscene. A completed live session's hydrated history restores
only the final screen, without replaying the animation or speech. A genuine restart resets the
clock, cue cursor, modal, focus and camera/scene selection after the new world is observed.
Errors remain visible inside the modal.

Stable DOM IDs are `win-ending`, `win-shade`, `win-caption`, `win-card`, `win-title`,
`win-message`, `win-skip`, `win-pause`, `win-mute`, `win-restart` and `win-error`.
`aegis.presentation().winEnding` reports `{ active, phase, seconds, duration, paused,
reducedMotion }`, with phase `hidden`, `playing`, `shown` or `restarting`; `paused` is the
local cutscene pause. Custom hosts must supply `onGameplayBlocked`, just as for loss endings.
Omitting `ui.winEnding` preserves existing win presentation.

## Spatial sound and captions

Existing `audio.ambient` and event cues remain supported. New `audio.layers` entries contain
`{ id, asset, volume?, spatial?, enabledWhen?, fadeSeconds? }`. Up to eight combined layers and
legacy ambient are allowed. Layer state comes from the mirrored world, not audio timing.

`spatial` contains `target: { entity: "actor" }` or `{ position: [x,y,z] }`, plus optional
`refDistance`, `maxDistance` and `rolloffFactor`. Defaults are 1.5, 22 and 1. HRTF/inverse-distance
PannerNodes use **mono** decoded assets; stereo spatial assets are refused. Stereo nonspatial
ambience/music is supported. Entity positions and the listener's camera position, forward and
up directions are refreshed each frame. This is geometric distance/direction, not acoustic
occlusion, room reverb or sound propagation through doors.

Event cues accept `maxVoices`, `fadeSeconds`, the same `spatial`, and
`when: { field: "variant", equals: 2 }` for scalar selection from `event.data`. A missing or
invalid authored payload path is an error. The predicate selects authored media; it does not
introduce random behavior. `voiceGroup: "dialogue"` optionally makes all cues in that named
group monophonic: a new voice replaces the previous one even across different cue events.
`audio.headroom` multiplies master volume once (default 1); it is not a limiter or loudness
normalizer. Author source loudness and mix gains deliberately.

`caption: { text, speaker?, durationTicks? }` emits readable metadata even while sound is locked
or muted. Default caption duration is 240 ticks. Caption-only cues may omit `asset`. Event
sequence/cooldown checks still apply; unlock, unmute, resume and generation reset never replay
an old cue backlog. A trusted gesture is required to create/resume Web Audio. Pause/mute/dispose
release active sources; audible layer transitions use gain fades.

## Preview and acceptance scope

Selecting a descriptor material/model preserves the cinematic settings and reflection dependency,
but does not instantiate gameplay entities, lights, bindings, effects or audio. Studio lighting
is still the selected studio rig. Capture recipes include the pipeline settings, quality and
reflection selection. Exact-size captures beyond the descriptor's pixel budget are refused;
author `quality: "photo"` for up to 4K instead of silently shrinking a requested PNG.

Asset previews, primitive lighting fixtures and engine tests do not certify the final game's
readability, art direction, audio mix, playability, GPU memory or 60 fps performance.

Repository browser tests can use `browser-navigation.ts`'s
`navigateAndWait(cdp, trigger, { timeoutMs, signal })` around an explicit `Page.reload` or a real
retry-button click. It subscribes before the trigger and requires a new main-frame loader, its
load lifecycle event and a fresh default execution context. The single budget defaults to 30
seconds and cannot exceed it; take that time from the caller's existing readiness window.
This establishes document navigation, not asset readiness. The production fetch-preload path
can keep an image pending while document load has completed, presentation is still `loading`
and the public tick is `-1`; retain those separate loading/ready assertions after an initial
navigation barrier. Asset hot reload does not create a new document and must not use this helper.

Cancellation rejects the waiter and removes its listeners, without undoing a navigation already
started. Genuine disconnects remain fatal. Only the known `Input.dispatchMouseEvent` context-replaced
reply can be accepted after the complete navigation proof, and the result reports it as
`replacedTriggerReply`. All other protocol errors retain their command and code and propagate;
ordinary `until()` evaluation errors are never broadly caught or retried.
