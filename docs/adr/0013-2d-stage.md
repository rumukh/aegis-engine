# ADR-0013: a WebGL 2D puppet stage as `@aegis/browser` subpaths

Status: accepted for spec section 23 (ANIM-01..07), 2026-10-08.

## Context

Fluffy Bureau needs real-time layered 2D puppets with lip-sync, runtime avatar composition
and in-engine cutscenes on Windows browsers and landscape tablets, including iPadOS Safari on
iPad (9th generation) class hardware (spec 23.2, decisions T02 and T05). ANIM-01 requires a
browser-safe entry with no three.js, renderer or Node imports, the logical coordinate space of
`logicalPoint`/`hitHotspot`, ordered layers, a clamped camera, and a 60 fps target with a 30 fps
floor for four puppets, effects and a 2048x1536-class background, chosen **by measurement**.

## Measurement

`scripts/bench-stage.mjs` draws one deterministic scene with three interchangeable renderers:
four puppets of 24 hierarchical parts each, every part transformed every frame, eye and mouth
swaps, one runtime-tinted scarf per puppet, 40 alpha particles and a 2560x1600 background.

- DOM/CSS: absolutely positioned elements with flattened `matrix()` transforms and
  `will-change: transform`; tint through a per-colour pre-tinted canvas.
- Canvas 2D: one device-pixel canvas, `setTransform` + `drawImage` per part, tint cached once
  per (mask, colour).
- WebGL: a raw WebGL 1 textured-quad batch (one dynamic vertex buffer, one draw per texture),
  tint as a per-vertex multiply on a mask.

Each configuration warms up for 2 s and records 5 s of `requestAnimationFrame` intervals in the
page, plus the JavaScript time of each draw. Three interleaved rounds; medians reported.
Chromium 153 on a 16-thread Ryzen 7 5800X, Windows 11, with the repository's default
**SwiftShader software rasterisation** (`launchBrowser`), i.e. no GPU help:

| viewport (CSS px @ DPR) | CPU throttle | WebGL fps | Canvas 2D fps | DOM fps | WebGL p95 interval | WebGL draw JS (median) |
| ----------------------- | ------------ | --------- | ------------- | ------- | ------------------ | ---------------------- |
| 1280x800 @ 1            | 1x           | 59.9      | 60.0          | 60.0    | 16.8 ms            | 0.7 ms                 |
| 1280x800 @ 1            | 4x           | **59.1**  | 56.5          | 42.9    | 16.8 ms            | 4.1 ms                 |
| 1024x768 @ 2            | 1x           | 39.7      | 44.3          | 60.0    | 33.4 ms            | 0.5 ms                 |
| 1024x768 @ 2            | 4x           | 38.1      | 37.6          | 37.0    | 33.4 ms            | 5.6 ms                 |

DOM node count: 145 (DOM) against 9 (canvas and WebGL). The same matrix with hardware
rasterisation (`--graphics hardware`, ANGLE D3D11 on an RTX 4070 Ti SUPER):

| viewport (CSS px @ DPR) | CPU throttle | WebGL fps | Canvas 2D fps | DOM fps |
| ----------------------- | ------------ | --------- | ------------- | ------- |
| 1280x800 @ 1            | 4x           | 60.0      | 59.8          | 39.5    |
| 1024x768 @ 2            | 4x           | 59.6      | 60.0          | 54.5    |

Playwright WebKit 1.63 on the same machine (WebGL renderer reported as "Apple GPU"; no CPU
throttling available, unthrottled; two runs, the second shown):

| viewport     | WebGL fps | Canvas 2D fps | DOM fps |
| ------------ | --------- | ------------- | ------- |
| 1280x800 @ 1 | **87.7**  | 23.1          | 20.1    |
| 1024x768 @ 2 | 28.2      | 9.9           | 10.3    |

Raw results: `bench-stage-*.json`/`.md` produced by the script (`--out`); the run is
reproducible with `node scripts/bench-stage.mjs --rounds 3`.

## Decision

1. **WebGL 1 is the stage renderer**, with an automatic **Canvas 2D fallback** when a WebGL
   context cannot be created (`renderer: 'auto'`). DOM/CSS is not offered: it is the slowest
   path under throttling, 16x the node count, and in WebKit it misses the floor everywhere.
   WebGL is the only technique that keeps the 30 fps floor in WebKit at 1x DPR, and it has the
   lowest JavaScript cost per frame under 4x throttling in Chromium. With hardware rasterisation
   WebGL holds 60 fps under 4x CPU throttling at both viewports.
2. The renderer is a small batched quad renderer written for this stage (no three.js):
   premultiplied textures, multiply tint with an optional mask, a comfort grade uniform, one
   draw call per texture run. Textures are re-uploaded after a WebGL context loss.
3. **Package boundary:** two opt-in subpaths of `@aegis/browser`, not a new package.
   - `@aegis/browser/animation`: formats, validators, cue import, deterministic sampling, the
     puppet model and the cutscene player. No DOM; it type-checks without DOM types and runs in
     Node. The `aegis-animation` bin validates documents headlessly.
   - `@aegis/browser/stage`: the browser stage, renderers, lip-sync binding and cutscene host.
     The stage needs the narration controller (`audio`), logical coordinates (`ui`) and asset URL
     rules (`io`) that already live in `@aegis/browser`; a separate package would either duplicate
     them or depend on `@aegis/browser` anyway. Keeping one package leaves the consumer's
     four-tarball SDK install unchanged and the dependency DAG (`check-deps`) untouched. The
     standalone consumer check now executes `@aegis/browser/animation` in its headless bundle.

## Consequences

- **Fill rate at 2x DPR is the binding constraint.** With software rasterisation every
  technique lands near 38 fps at a 2048x1536 backing store, above the 30 fps floor but below the
  60 fps target; with hardware rasterisation Chromium holds 60 fps. Playwright WebKit on Windows reached 22-28 fps at 2x (its WebGL renderer string is masked, so GPU use is unconfirmed). Real iPads rasterise on the GPU, so
  these numbers bound the CPU side only; they are not iPad results. The stage caps the device
  pixel ratio at 2 by default (`maxDevicePixelRatio`), which a consumer can lower (for example
  1.5) if physical-device acceptance shows a shortfall. Physical-device measurement remains
  consumer acceptance (spec 17, "Browser/device scope").
- The section 23 browser specs assert the 30 fps floor in Chromium under 4x CPU throttling at
  1280x800 with the real stage (F01) and record the measured value; they do not claim the 60 fps
  target.
- Presentation code uses `Math.sin`/`Math.cos`. It is deterministic on one machine (a clip
  time maps to one pose; tests compare repeated samples) but not bit-identical across
  platforms. That is acceptable only because presentation never writes authoritative state
  (TURN-01, K01); the determinism lint still bans these functions in simulation packages.
- Images load through `<img>` from their same-origin URL, so a strict `img-src 'self'` CSP
  needs no `blob:` exception, and the offline service worker serves them from installed packs.
