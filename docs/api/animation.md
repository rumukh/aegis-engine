# 2D animation: formats and APIs

Status: **format version 1, implemented** (2026-10-08). The formats below were first
published as the E0 contract and are now validated by `@aegis/browser/animation` and the
`aegis-animation` CLI. Any change is announced to every consumer with a versioned note.
Changes since the E0 draft (c35d3a4): the fallback-to-rest rule is `X` → `A` only for rigs
without `X` (required anyway); `PuppetSpec` adds `private`, `layer` and `behaviours`; the
stage adds `toScene`/`toClient`, `clearScene`/`release`, `setPrivacy` and `stats`.

Specification: [section 23.2](../specs/aegis-extension-spec.md) (ANIM-01..07) and
AUDIO-07 in section 23.3. Technology and package boundary:
[ADR-0013](../adr/0013-2d-stage.md).

## 1. Entry points

| Entry                      | Environment     | Contents                                                                                                           |
| -------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `@aegis/browser/animation` | Browser or Node | Format types, validators, Rhubarb/viseme import, deterministic pose sampling, cutscene planning. No DOM.           |
| `@aegis/browser/stage`     | Browser         | The stage: image/atlas loading, layers, camera, puppets, lip-sync binding, cutscene player, comfort, disposal.     |
| `@aegis/browser/audio`     | Browser         | Existing narration service, extended with the playback clock, line metadata and label speech (section 6).          |
| `aegis-animation` (bin)    | Node            | `aegis-animation validate <files or dirs>`: headless validation of rigs, atlases, clips, cutscenes and cue tracks. |

Nothing here imports three.js, the renderer or Node built-ins on a browser path.
Everything is opt-in: existing consumers that do not import these entries are
unaffected.

## 2. Conventions shared by every format

- **JSON, UTF-8, versioned** by a `format` discriminator such as `"aegis-rig/1"`.
  Unknown fields are errors, not ignored, so typos are caught.
- **IDs** match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` (the existing browser-service ID
  rule). Asset IDs are the IDs of `OfflineResource` entries in the consumer's offline
  packs, so every image, atlas and cue file is installed and cached with its pack.
- **Coordinates:** logical pixels, **y down**, origin top-left, exactly the space used
  by `logicalPoint`, `hitHotspot` and `createHotspotList`. The Fluffy Bureau stage is
  2560x1600 with the 2100x1440 safe area centred (plan 5.6).
- **Angles** in degrees, positive is clockwise on screen. **Times** in seconds.
- **Colours** as `#rrggbb`.
- Diagnostics use stable codes `AEG-ANIM-nnnn` with a JSON path, like
  `AEG-CONTENT-nnnn` (section 9).

## 3. Images and atlases

### 3.1 Constraints

| Rule                      | Value                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Formats                   | WebP (lossless or high-quality lossy with alpha) for raster; PNG accepted. No SVG inside rigs.                  |
| Maximum texture side      | **4096 px** (iPadOS Safari). Recommended atlas size 2048x2048. Backgrounds 2560x1600.                           |
| Alpha                     | Straight (non-premultiplied) alpha. Leave 2 px transparent padding around every frame (no bleeding).            |
| Packing                   | Frames are axis-aligned rectangles; **no rotated packing**. Trimming is allowed (see `offset`/`source`).        |
| Decoded memory accounting | `width x height x 4` bytes per image, counted against a per-pack budget the consumer declares (default 96 MiB). |
| Colour                    | sRGB.                                                                                                           |

### 3.2 Atlas file `aegis-atlas/1`

```json
{
  "format": "aegis-atlas/1",
  "id": "fox.atlas",
  "image": "fox.atlas.webp",
  "width": 2048,
  "height": 2048,
  "scale": 1,
  "frames": {
    "torso": { "x": 2, "y": 2, "w": 420, "h": 610 },
    "head.neutral": { "x": 426, "y": 2, "w": 512, "h": 470 },
    "mouth.A": {
      "x": 942,
      "y": 2,
      "w": 120,
      "h": 70,
      "offset": { "x": 4, "y": 6 },
      "source": { "w": 128, "h": 80 }
    }
  }
}
```

- `image` is the asset ID of the image; `width`/`height` must equal its decoded size
  (checked at load).
- `scale` is logical pixels per atlas pixel. Use `0.5` for half-resolution art; the
  rig is still authored in logical pixels.
- `offset` and `source` describe trimming: the untrimmed frame is `source` large and
  the stored rectangle is placed at `offset` inside it. Pivots refer to the
  **untrimmed** frame, so trimming never moves a pivot.
- A frame is referenced from rigs as `"<atlas id>#<frame id>"`, e.g. `"fox.atlas#torso"`.

Any packer that writes these fields works. A converter from the TexturePacker
"JSON (Hash)" export is part of the validator tooling.

## 4. Rig `aegis-rig/1`

A rig is one character: a hierarchy of parts, each drawing one frame chosen from a
small set of named variants. Avatar species share **the same part IDs**, so clips,
behaviours and anchors work across species.

```json
{
  "format": "aegis-rig/1",
  "id": "avatar.fox",
  "revision": "1",
  "atlases": ["fox.atlas"],
  "origin": { "x": 0, "y": 0 },
  "bounds": { "x": -260, "y": -900, "width": 520, "height": 920 },
  "parts": [
    {
      "id": "body",
      "frame": "fox.atlas#torso",
      "pivot": { "x": 210, "y": 600 },
      "position": { "x": 0, "y": 0 },
      "z": 10
    },
    {
      "id": "tail",
      "parent": "body",
      "frame": "fox.atlas#tail",
      "pivot": { "x": 20, "y": 180 },
      "position": { "x": 150, "y": -120 },
      "z": 5
    },
    {
      "id": "head",
      "parent": "body",
      "pivot": { "x": 256, "y": 440 },
      "position": { "x": 0, "y": -560 },
      "z": 20,
      "variants": { "neutral": "fox.atlas#head.neutral", "turned": "fox.atlas#head.turned" },
      "variant": "neutral"
    },
    {
      "id": "eyes",
      "parent": "head",
      "pivot": { "x": 90, "y": 40 },
      "position": { "x": 0, "y": -210 },
      "z": 21,
      "variants": {
        "open": "fox.atlas#eyes.open",
        "half": "fox.atlas#eyes.half",
        "closed": "fox.atlas#eyes.closed"
      },
      "variant": "open"
    },
    {
      "id": "brows",
      "parent": "head",
      "pivot": { "x": 100, "y": 20 },
      "position": { "x": 0, "y": -270 },
      "z": 22,
      "variants": {
        "neutral": "fox.atlas#brows.neutral",
        "up": "fox.atlas#brows.up",
        "worried": "fox.atlas#brows.worried"
      },
      "variant": "neutral"
    },
    {
      "id": "mouth",
      "parent": "head",
      "pivot": { "x": 64, "y": 40 },
      "position": { "x": 0, "y": -110 },
      "z": 23,
      "variants": {
        "X": "fox.atlas#mouth.X",
        "A": "fox.atlas#mouth.A",
        "B": "fox.atlas#mouth.B",
        "C": "fox.atlas#mouth.C",
        "D": "fox.atlas#mouth.D",
        "E": "fox.atlas#mouth.E",
        "F": "fox.atlas#mouth.F"
      },
      "variant": "X"
    },
    {
      "id": "arm.r",
      "parent": "body",
      "frame": "fox.atlas#arm.r",
      "pivot": { "x": 40, "y": 30 },
      "position": { "x": -140, "y": -430 },
      "z": 30
    }
  ],
  "roles": { "mouth": "mouth", "eyes": "eyes", "brows": "brows", "head": "head", "lookAt": "head" },
  "expressions": {
    "neutral": { "brows": "neutral", "eyes": "open" },
    "surprised": { "brows": "up", "eyes": "open" },
    "worried": { "brows": "worried" }
  },
  "slots": {
    "scarf": { "parent": "body", "position": { "x": 0, "y": -470 }, "z": 25 },
    "hat": { "parent": "head", "position": { "x": 0, "y": -380 }, "z": 40 }
  },
  "tints": {
    "scarf": { "default": "#c8553d" }
  },
  "emotes": {
    "joy": { "expression": "surprised", "clip": "hop.small" }
  }
}
```

### 4.1 Parts

| Field                 | Meaning                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                  | Unique within the rig. Avatar species must use identical IDs.                                         |
| `parent`              | Optional parent part or slot ID. Absent means the rig root. Cycles are errors.                        |
| `frame` or `variants` | Exactly one: a single frame, or named variants with a default `variant`.                              |
| `pivot`               | Rotation/scale centre in the (untrimmed) frame's pixels. Must lie inside the frame (`AEG-ANIM-0012`). |
| `position`            | Where the pivot sits in the parent's space (logical pixels; the parent's pivot is its origin).        |
| `rotation`, `scale`   | Optional rest transform: degrees and `{ "x": 1, "y": 1 }`.                                            |
| `opacity`             | Optional rest opacity 0..1.                                                                           |
| `z`                   | Integer draw order **within the puppet** (global, not per parent). Ties are an error.                 |
| `tint`                | Optional `{ "channel": "scarf", "mask": "<atlas>#<frame>" }`; see 4.3.                                |

A rig root point is the puppet's placement point (`origin`), usually between the feet.
`bounds` is the declared visual extent around the origin, used for camera framing and
culling.

### 4.2 Expressions, eyes and mouth

- `roles` names the parts the engine drives: `mouth` (lip-sync), `eyes` (blink, using
  variants `open`, `half`, `closed`), `brows`, `head` and `lookAt` (the part rotated
  by look-at).
- `expressions` set variants on several parts at once. A clip or cutscene asks for an
  expression by name.
- The mouth part's variants are named with the **engine mouth set** (section 5). A rig
  must provide `X` and `A`-`F`; `G` and `H` are optional (6-9 shapes, as T05 asks).

### 4.3 Avatar composition, tint and anchors

An avatar is composed at runtime from a **species base rig plus accessory rigs**:

```ts
const avatar = stage.puppet({
  rig: 'avatar.fox',
  accessories: [
    { slot: 'scarf', rig: 'acc.scarf.long' },
    { slot: 'hat', rig: 'acc.hat.detective', variant: 'brown' },
  ],
  tints: { scarf: '#2f6fb3' },
});
```

- An accessory is an ordinary `aegis-rig/1` whose root attaches to the base rig's
  **slot** (`slots.<id>`: parent, position, z). Its parts draw at the slot's `z`, in their
  own `z` order. Accessory rigs may themselves declare slots and `anchors`.
- **Tint:** a part with `tint: { channel }` is multiplied by the channel colour. With a
  `mask` frame (same size as the part frame, greyscale/alpha), only masked pixels are
  tinted, so stitching and highlights painted outside the mask keep their colour. Paint
  tintable areas in **light neutral grey** (about `#d0d0d0` to `#ffffff`) with shading in
  grey, so multiply produces the declared colour range. The consumer owns the palette;
  the rig declares only channels and a default.
- **Anchors** (`anchors: { "badge": { "part": "scarf.knot", "x": 30, "y": 12 } }` in a rig
  or accessory) are named points that follow their part. Another accessory (the badge)
  attaches to an anchor with `{ anchor: 'badge', rig: 'acc.badge' }`.
- Five species x every scarf colour x every hat render without pre-rendered
  combinations: composition is per-instance, tinted parts are cached per
  `(frame, colour)` once.

### 4.4 Diagnostics (validator and loader)

Missing part/frame/atlas, parent cycles, pivot outside frame, duplicate `z`, unknown
variant, mouth set missing required shapes, unknown mouth shape in a cue track, an
atlas side over 4096 px, declared atlas size different from the decoded image, a pack
exceeding its decoded-memory budget, unknown slot or anchor, unknown tint channel.

## 5. Mouth shapes

The engine mouth set is the Preston Blair / Rhubarb Lip Sync set. Rhubarb output is
used unchanged.

| Shape | Mouth                                 | Sounds (approx.)              | If missing, use |
| ----- | ------------------------------------- | ----------------------------- | --------------- |
| `X`   | Rest, relaxed and closed              | Silence, pauses               | `A`             |
| `A`   | Closed, lips pressed                  | M, B, P                       | required        |
| `B`   | Slightly open, teeth together or near | Most consonants (K, S, T), EE | required        |
| `C`   | Open                                  | EH, AE; Russian Э, Е          | required        |
| `D`   | Wide open                             | AA; Russian А                 | required        |
| `E`   | Slightly rounded                      | AO, ER; Russian О             | required        |
| `F`   | Puckered, small round                 | UW, OW, W; Russian У, Ю       | required        |
| `G`   | Upper teeth on lower lip              | F, V; Russian Ф, В            | `B`             |
| `H`   | Tongue raised behind teeth            | Long L; Russian Л             | `C`             |

### 5.1 Mapping from other viseme sets

Cue tracks may be authored in another set and are mapped on import
(`importVisemes(set, events)`).

**Azure Speech viseme IDs** (`VisemeReceived`, IDs 0-21, language-independent):

| Azure ID | 0   | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  | 11  | 12  | 13  | 14  | 15  | 16  | 17  | 18  | 19  | 20  | 21  |
| -------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shape    | X   | C   | D   | E   | C   | E   | B   | F   | F   | D   | E   | D   | B   | E   | H   | B   | B   | B   | G   | B   | B   | A   |

Azure reports `audioOffset` in 100-ns ticks from the start of the synthesized audio;
divide by 10 000 000 for seconds. A viseme holds until the next event.

**Oculus/Meta OVR 15 visemes:** `sil`→X, `PP`→A, `FF`→G, `TH`→B, `DD`→B, `kk`→B,
`CH`→B, `SS`→B, `nn`→B, `RR`→E, `aa`→D, `E`→C, `ih`→B, `oh`→E, `ou`→F.

**Rhubarb JSON export** (`rhubarb -f json`) is imported directly with
`importRhubarb(json, { lineId })`: `mouthCues[].start` and `.value` become cues and
`metadata.duration` becomes the track duration.

## 6. Cue track `aegis-cues/1`

One per spoken line, keyed by the line ID.

```json
{
  "format": "aegis-cues/1",
  "line": "case01.l1.watsoni.003",
  "revision": "2",
  "duration": 3.42,
  "cues": [
    { "t": 0.0, "s": "X" },
    { "t": 0.12, "s": "B", "a": 0.55 },
    { "t": 0.21, "s": "D", "a": 0.9 },
    { "t": 0.36, "s": "C" },
    { "t": 3.3, "s": "X" }
  ]
}
```

- `t` strictly increasing, `0 <= t < duration`; each shape holds until the next cue;
  after `duration` the mouth is at rest (`X`). `s` is an engine mouth shape. Optional
  `a` (0..1) is amplitude, used to scale jaw-like motion if the rig declares it; it is
  never required.
- `duration` should equal the audio duration within 50 ms; the validator warns
  otherwise (`AEG-ANIM-0031`), because a mismatch usually means a stale cue file.
- `revision` should be the voice line's revision so stale cues are detectable.
- The producer is irrelevant: Rhubarb, Azure viseme events or hand editing.
- The stage and the validator also accept **raw Rhubarb JSON** (mouthCues) as a cue
  file; the validator names its line from the file name <line>[.<hex hash>].cues.json.

Lip-sync samples the cue track at the **narration playback clock** (section 7) every
frame. Pause, resume, replay, stop and interruption keep drift within 50 ms; after stop,
completion or failure the mouth returns to `X`.

Fallbacks (ANIM-04): no cue track: amplitude from the decoded buffer, otherwise a
generic talk loop for the line's duration. Narration blocked or failed: the mouth stays
neutral, or a bounded subtle talk loop while the caption is visible (consumer option);
it never claims synchronized speech. Muted volume still animates from cues.

## 7. Narration clock and line metadata (AUDIO-07)

Additive to the existing `createNarration` controller. Existing calls keep their
behaviour.

```ts
interface NarrationLine {
  id: string;
  asset: string;
  caption: string;
  /** New, optional. Speaker ID, e.g. a cast/rig role. */
  speaker?: string;
  /** New, optional. Asset ID of an aegis-cues/1 file in the same pack. */
  cues?: string;
  /** New, optional. Consumer metadata, JSON scalars only. */
  meta?: Readonly<Record<string, string | number | boolean>>;
  /** New, optional. 'line' (default) or 'label' for spoken interface labels. */
  kind?: 'line' | 'label';
}

interface NarrationClock {
  /** Increments for every playLine/replay/speakLabel request. */
  serial: number;
  packId?: string;
  lineId?: string;
  kind?: 'line' | 'label';
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'completed' | 'blocked' | 'failed';
  /** Seconds into the line's audio as currently audible (output latency compensated), >= 0. */
  position: number;
  /** Decoded duration in seconds once known. */
  duration?: number;
}

interface NarrationEvent {
  type: 'start' | 'pause' | 'resume' | 'stop' | 'complete' | 'fail' | 'block';
  serial: number;
  packId: string;
  lineId: string;
  kind: 'line' | 'label';
  position: number;
  reason?: 'replaced' | 'stopped' | 'label' | 'cleared' | 'interrupted' | 'released';
}

narration.clock(): NarrationClock; // allocation-light; safe to call every animation frame
narration.subscribe(listener: (event: NarrationEvent) => void): () => void;
narration.line(packId: string, lineId: string): NarrationLine | undefined;
narration.speakLabel(packId: string, lineId: string, options?: { policy?: 'replace' | 'queue' }): Promise<void>;
narration.context(): { state: 'none' | 'suspended' | 'running' | 'closed' | 'interrupted'; sampleRate?: number };
```

- **Position** is derived from the audio context clock, never wall time:
  `offset + (context.currentTime - startedAt) - outputLatency`, clamped to
  `[0, duration]`. While paused it is frozen; after resume it continues from the same
  offset; `replay` restarts at 0 with a new `serial`; gesture recovery after an
  interruption resumes from the saved offset.
- **Label speech** (Q29 "ear" buttons): `speakLabel` plays a pack line of
  `kind: 'label'`. Policy `replace` (default) stops the active line (event `stop` with
  `reason: 'label'`) and does **not** resume it afterwards; `queue` plays the label
  after the active line completes. Labels never change the caption callback.
- **Issue #13** (same controller): `preload(packId, assetIds?)`,
  `playEffect(packId, assetId, { gain })`, `setAtmosphere({ ..., loopStart, loopEnd })`,
  effect failures reported through `effects` status and events without changing the
  narration `status`, and `context()` above.

## 8. Clip `aegis-clip/1`

Keyframed motion of parts by ID. Clips are rig-independent and validated against a rig
when bound.

```json
{
  "format": "aegis-clip/1",
  "id": "wave",
  "duration": 1.2,
  "loop": false,
  "blend": "override",
  "tracks": [
    {
      "part": "arm.r",
      "property": "rotation",
      "keys": [
        { "t": 0, "v": 0, "ease": "easeOutCubic" },
        { "t": 0.3, "v": -40, "ease": "easeInOutSine" },
        { "t": 0.6, "v": -20, "ease": "easeInOutSine" },
        { "t": 0.9, "v": -40 },
        { "t": 1.2, "v": 0 }
      ]
    },
    {
      "part": "brows",
      "property": "variant",
      "keys": [
        { "t": 0, "v": "up" },
        { "t": 1.0, "v": "neutral" }
      ]
    },
    {
      "part": "body",
      "property": "y",
      "keys": [
        { "t": 0, "v": 0 },
        { "t": 0.6, "v": -8 },
        { "t": 1.2, "v": 0 }
      ]
    }
  ],
  "events": [{ "t": 0.3, "name": "wave.peak" }]
}
```

- Properties: `x`, `y` (offset from the rest position, logical px), `rotation` (deg,
  added to rest), `scaleX`, `scaleY` (multiplied with rest), `opacity` (multiplied) and
  `variant` (step only). Use `expression` as a part-less track to switch expressions.
- `ease` on a key shapes the segment **leaving** that key: `linear` (default), `step`,
  `easeIn|Out|InOut` + `Quad|Cubic|Sine|Back`, or `[x1, y1, x2, y2]` cubic Bezier.
- `blend: "override"` replaces lower layers for the animated properties (with an
  optional crossfade when started); `"additive"` adds (x, y, rotation) or multiplies
  (scale, opacity) onto lower layers, e.g. breathing under a gesture.
- `loop: true` wraps time; keys at `t = 0` and `t = duration` should match.
- **Deterministic sampling:** `sampleClip(clip, t)` returns exactly one pose for a time;
  seeking and skip-to-end use the same function. Events are presentation-only.

### 8.1 Built-in behaviours

Configured per puppet at runtime; no authored files needed. Randomness uses a
presentation-only seeded PRNG (never the runtime's), so the same seed gives the same
blinks in tests.

| Behaviour | Parameters (defaults)                                                     |
| --------- | ------------------------------------------------------------------------- |
| `breathe` | `amplitude` 6 px on `body` y and 1.5% scaleY, `period` 3.6 s              |
| `bob`     | `amplitude` 4 px, `period` 1.8 s (idle sway)                              |
| `blink`   | `interval` 2.5-6 s, `duration` 0.15 s (half, closed, half), `seed`        |
| `lookAt`  | target point or puppet; rotates `roles.lookAt` up to 12 deg, eases 0.25 s |
| `hop`     | `height` 40 px, `duration` 0.45 s, squash on landing                      |
| `walk`    | `path` of points, `speed` px/s, bobbing gait, faces direction (flip x)    |
| `emote`   | rig `emotes.<name>`: expression + clip, optional stage effect             |

## 9. Cutscene `aegis-cutscene/1`

A cutscene is an ordered list of steps. Each step starts when the previous **blocking**
step has finished; a step with `"wait": false` starts and the list continues at once.
Use `join` to wait for everything still running.

```json
{
  "format": "aegis-cutscene/1",
  "id": "prologue.intro",
  "revision": "1",
  "advance": "input",
  "cast": {
    "watsoni": { "rig": "char.watsoni" },
    "player": { "role": "avatar" }
  },
  "steps": [
    {
      "op": "background",
      "asset": "bg.bureau.night",
      "comfort": { "asset": "bg.bureau.night.warm" }
    },
    { "op": "camera", "preset": "wide", "cut": true },
    { "op": "music", "asset": "music.mystery", "fade": 1.5, "wait": false },
    {
      "op": "enter",
      "actor": "watsoni",
      "from": "left",
      "to": { "x": 900, "y": 1450 },
      "duration": 1.4
    },
    {
      "op": "enter",
      "actor": "player",
      "from": "right",
      "to": { "x": 1650, "y": 1450 },
      "duration": 1.4,
      "wait": false
    },
    { "op": "emote", "actor": "watsoni", "emote": "joy" },
    { "op": "line", "actor": "watsoni", "line": "prologue.003" },
    { "op": "marker", "id": "met-player" },
    {
      "op": "camera",
      "to": { "x": 1280, "y": 900, "zoom": 1.3 },
      "duration": 2.0,
      "ease": "easeInOutSine"
    },
    { "op": "pose", "actor": "player", "expression": "surprised", "clip": "wave" },
    { "op": "line", "actor": "player", "line": "prologue.004" },
    {
      "op": "effect",
      "effect": "sparkles",
      "at": { "x": 1650, "y": 1100 },
      "duration": 2,
      "wait": false
    },
    { "op": "wait", "for": "input" },
    { "op": "exit", "actor": "watsoni", "to": "left", "duration": 1.2 },
    { "op": "transition", "type": "fade", "duration": 0.8 }
  ]
}
```

| `op`         | Fields                                                                                  | Blocking by default |
| ------------ | --------------------------------------------------------------------------------------- | ------------------- |
| `background` | `asset`, optional `transition` `{ type: cut \| crossfade, duration }`                   | yes (transition)    |
| `camera`     | `preset` (consumer-declared framings) or `to { x, y, zoom }`, `duration`, `ease`, `cut` | yes                 |
| `enter`      | `actor`, `from` (`left`/`right`/point), `to`, `duration`, `walk` (bool, default true)   | yes                 |
| `exit`       | `actor`, `to`, `duration`                                                               | yes                 |
| `move`       | `actor`, `to` or `path`, `duration` or `speed`                                          | yes                 |
| `pose`       | `actor`, any of `expression`, `clip`, `face` (`left`/`right`)                           | clip length         |
| `emote`      | `actor`, `emote`                                                                        | yes                 |
| `line`       | `actor` (optional for the narrator), `line` (narration line ID), `advance` override     | see below           |
| `music`      | `asset` or `null`, `fade`                                                               | no                  |
| `atmosphere` | `asset` or `null`, `fade`                                                               | no                  |
| `sfx`        | `asset`, `gain`                                                                         | no                  |
| `effect`     | `effect` (consumer-registered), `at`, `duration`                                        | yes                 |
| `transition` | `type` (`fade`, `crossfade`), `duration`, `color`                                       | yes                 |
| `wait`       | `seconds`, or `for: "input"`                                                            | yes                 |
| `marker`     | `id`                                                                                    | instant             |
| `join`       |                                                                                         | until all finished  |

- Any step may carry `"comfort": { ...fields }`: when comfort is on, those fields
  replace the step's own (for example a warmer background or a calmer clip).
- **Lines:** a `line` step plays the narration line, binds lip-sync for its actor,
  shows the caption (every spoken line has one) and waits until the line completes,
  fails or is blocked. Then, with the default `advance: "input"`, it waits for
  `player.next()` (Q29: no automatic text advance). `advance: "auto"` continues once
  the line ends.
- **Player avatar:** a cast entry with `role: "avatar"` is bound at `play()` time to the
  active profile's composition (section 4.3).
- **Control:** `pause(reason)` composes with HOST-03 reasons and `bindVisibilityPause`;
  `resume(reason)`; `skip()` jumps to the end state (every step applied instantly, no
  narration, no effects); `replay()` restarts; `play(cutscene, { from: markerId })`
  starts at a marker by applying earlier steps instantly. Restoring a save during a
  cutscene restarts it from the start or from the last marker the consumer stored.
- **Presentation only:** the player emits events (`step`, `line`, `caption`,
  `awaiting-input`, `marker`, `completed`, `skipped`) and never touches runtime state.
  The consumer commits "completed" or "skipped" through an ordinary runtime command.

## 10. Stage (browser)

```ts
import { createNarration } from '@aegis/browser/audio';
import { createStage } from '@aegis/browser/stage';

const narration = createNarration({ baseUrl, onState, onCaption });
narration.registerPack(voicePack); // lines may name their cue tracks (section 7)
const stage = createStage({
  host: element, // the stage canvas fills it; DOM controls stay outside
  baseUrl, // asset URLs are same-origin, relative to this
  resolve: (assetId) => paths[assetId], // offline-pack asset ID -> path
  logical: { width: 2560, height: 1600 }, // default
  memoryBudgetBytes: 96 * 1024 * 1024, // owned decoded images, width x height x 4
  renderer: 'auto', // WebGL, Canvas 2D fallback (ADR-0013)
  maxDevicePixelRatio: 2,
  cameraPresets: { close: { x: 1280, y: 1000, zoom: 1.5 } }, // `wide` is built in
  reducedMotion: 'system', // or true/false from the consumer setting
  comfort: { brightness: 1.12, warmth: 0.6 }, // the Q22 treatment, applied by setComfort
  effects: { sparkles: { frame: 'fx.atlas#spark', count: 16, life: 1.2 } },
  narration,
  audioPackId: 'case01-voice', // used by cutscene lines, music and sfx
  seed: 'presentation-seed',
});
const loaded = await stage.load({
  documents: ['avatar.fox.atlas', 'avatar.fox', 'wave'],
  images: ['bg.bureau.webp'],
});
if (!loaded.ok) show(loaded.diagnostics); // nothing is installed when validation fails
stage.setBackground('bg.bureau.webp');
const fox = stage.puppet({
  rig: 'avatar.fox',
  accessories,
  tints,
  at: { x: 900, y: 1450 },
  behaviours: { breathe: {}, blink: {} },
});
fox.play('wave');
await fox.speak({ packId: 'case01-voice', lineId: 'case01.l1.watsoni.003' });
fox.speech(); // { mode: 'cues' | 'talk-loop' | 'unheard' | 'rest', synchronized, shape }
const scene = stage.cutscene(cutsceneFile, { avatar: composition, onEvent });
scene.play(); // later: scene.next(), skip(), replay(), play({ from: 'marker' })
stage.setComfort(true);
stage.setReducedMotion(true);
stage.pause('menu'); // composes with bindVisibilityPause(document, stage.pause, stage.resume)
stage.toScene(clientPoint); // client -> scene coordinates through the camera (hotspots)
stage.toLogical(clientPoint); // same as logicalPoint, camera ignored
stage.clearScene(); // remove puppets, sprites, particles, background
stage.release({ atlases, images, rigs, clips }); // free owned memory between scenes
stage.stats(); // renderer, frames, drawCalls, quads, frameMs, ownedBytes, textures, listeners
await stage.dispose(); // releases images, textures, listeners, the frame loop and the canvas
```

- **Layers:** `background`, `midground`, `characters` (puppets, sorted by their y),
  `foreground`, `effects`. `addSprite({ layer, image, at })` places props; an `image` is
  an image asset ID or an `atlas#frame`.
- **Camera:** presets or `{ x, y, zoom }`, clamped so the view never leaves the scene.
  Puppets and `toScene`/`toClient` stay aligned through resize, letterboxing and
  rotation because both use the `logicalPoint` contain mapping.
- **Lip-sync:** `speak` binds the puppet's mouth to the narration clock of that line.
  With a valid cue track the mode is `cues` and `synchronized` is true. Without one the
  mouth follows a generic talk loop for the line's duration (`talk-loop`, not
  synchronized). When narration is blocked or failed the mouth stays neutral, or
  plays a bounded subtle loop with `{ unheard: 'subtle', maxSubtleSeconds }`, and never
  claims synchronized speech. Muted volume still animates from cues. After stop,
  completion or failure the mouth returns to `X`.
- **Reduced motion:** camera moves become a cut softened by a gentle dip, entrances and
  exits become 0.4 s fades, hops, gait and breathing are damped to 30%, particles stay
  still; lip-sync and blinking remain. Fades are at least 0.5 s: no flashing.
- **Comfort:** a brightness/warmth grade applied instantly and reversibly; cutscene
  steps may also swap assets with `comfort` variants.
- **Lifecycle:** hidden documents do no animation-frame work; presentation time stops
  while any pause reason is held; a WebGL context loss re-decodes and re-uploads owned
  images; `setPrivacy(true)` hides `private` puppets and sprites and stops a private
  puppet's narration (handoff, A30).
- **Authority:** the stage has no reference to runtime state. Presentation time is its
  own clock (TURN-01, K01).

## 11. Profiles

Profiles (SAVE-08) and `rebindSave` (issue #15) are documented in
[browser-services.md](./browser-services.md#profiles-save-08-and-rebinding-a-backup-issue-15).

## 12. Validation and the preview route (ANIM-07)

Headless validation, without a browser:

```powershell
npx aegis-animation validate assets\characters assets\cutscenes --lines content\voice-pack.json --durations assets\voice\durations.json
npx aegis-animation import-rhubarb voice\case01.l1.003.rhubarb.json --line case01.l1.003 --revision 2 --out voice\case01.l1.003.cues.json
npx aegis-animation import-azure voice\case01.l1.003.visemes.json --line case01.l1.003 --duration 3.42 --out voice\case01.l1.003.cues.json
```

`validate` reads every `*.json` below the given paths, keeps the animation documents and
validates them together: rigs against atlases, clips against every rig that has their
parts, cue tracks against audio durations, cutscenes against cast, rigs, clips, captioned
lines, camera presets and effects. Exit code 0 means valid (warnings allowed), 2 invalid.
The same checks are `validateBundle` in `@aegis/browser/animation`.

The **animation lab** (`npm run build:labs`, then `npm run preview:labs`) is the local
preview route. Without parameters it shows the original placeholder fixture: five species
with identical part IDs, a tint-masked scarf, hats, a badge anchor, clips, a cutscene and a
synthetic voice line with its cue track. To preview consumer files, mount their directory:

```powershell
npm run preview:labs -- --consumer F:\path\to\fluffy-assets
# open http://127.0.0.1:4318/animation-lab/?manifest=consumer/manifest.json
```

The manifest lists what to load, by asset ID, with paths relative to the manifest:

```json
{
  "paths": {
    "avatar.fox": "rigs/avatar.fox.json",
    "avatar.fox.atlas": "rigs/avatar.fox.atlas.json",
    "avatar.fox.atlas.webp": "rigs/fox.webp"
  },
  "documents": ["avatar.fox.atlas", "avatar.fox", "acc.scarf.long", "wave"],
  "images": ["bg.bureau.webp"],
  "background": "bg.bureau.webp",
  "audio": {
    "id": "voice",
    "revision": "1",
    "assets": [{ "id": "l1", "src": "voice/l1.mp3" }],
    "lines": [
      { "id": "case01.l1.003", "asset": "l1", "caption": "…", "cues": "case01.l1.003.cues" }
    ]
  },
  "cutscenes": ["prologue.intro"],
  "avatars": {
    "species": ["avatar.fox"],
    "scarfColors": { "Синий": "#2f6fb3" },
    "hats": ["acc.hat.detective"],
    "badge": "acc.badge"
  }
}
```

The lab shows validation diagnostics, composes avatars, plays clips, emotes and lines with
lip-sync, speaks a label, plays, advances, skips and replays cutscenes, and toggles
reduced motion and comfort.
