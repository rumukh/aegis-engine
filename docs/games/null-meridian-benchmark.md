# NULL MERIDIAN full-route benchmark

From a clean revision, `npm ci && npm run build`, close other GPU-heavy workloads and run:

```sh
node scripts/bench-horror-route.mjs --device target --renderer "RTX 4070 Ti SUPER" --driver "<installed version>" --out "<outside-checkout>/rtx.json"
```

The target workload requires a real 4070 Ti SUPER and a measured 2560×1440 backing buffer with the shipped high pipeline. On a machine with verified integrated graphics, identify the actual adapter and its driver; for example, use `--device integrated --renderer "Iris Xe" --driver "<installed version>" --resolution 1280x720 --quality standard --out "<outside-checkout>/integrated.json"`. The driver and device class are operator declarations; also inspect the measured WebGL renderer and CDP device inventory. A virtual screen does not establish an integrated GPU. Software controls require `--device software` and must not be counted for either class.

Both runs traverse the entire winning `.input` at real-time fixed ticks in the normal live player; only input is injected. Loading is navigation-to-first-mounted-presentation, not launch-to-menu. Cold means a new browser profile, **not** a flushed OS/driver cache. Warm repeats in the same browser, profile and origin with a new page and fresh world; normal HTTP caching rules still apply. Timing starts at tick zero and covers active gameplay through extraction (`level.completed` at 8153); the ending film is not part of the route. Reject missing completion, death, mismatched resolution/renderer or exchange failures.

Read frame gap p95/p99 separately from CPU wall time inside the render call and sampled WebGL GPU elapsed queries. Queries need extension support; invalid/disjoint samples are not successful GPU measurements. The sampled peak is **renderer V8 used heap during the route**, not whole-process memory or GPU VRAM. Missing counters are `null`, not zero. Preserve both conditions and raw workload metadata; do not use a short pursuit, software rendering or a mean to claim sustained 1440p60.

## Measured target: full cold and warm routes

[Raw receipt](evidence/horror-758ef3e-rtx4070ti-super.json) (SHA-256 `ee4a519a26878b382a52ad7eff2421d63426414953c26a230cd23cfa57e40ae8`). Clean measurement revision `758ef3ea49dc7f7b0cf4a94972bed3b0325ce785`, November 21, 2026. Chrome 158, Windows, Ryzen 7 5800X, **active NVIDIA GeForce RTX 4070 Ti SUPER**, ANGLE D3D11, driver `32.0.16.2124`. Both runs measured 2560×1440 canvas **and** cinematic backing, high, DPR 1. Both started at tick 0 and observed power, recorder, chase, evasion and extraction at the pinned ticks, with `level.completed` at 8153, no player death and zero exchange errors.

| Condition | Load to ready | Route frames (gap samples) |      Gap p95 / p99 / max | CPU render p95 / p99 | GPU render p95 / p99 | Peak sampled V8 used heap |
| --------- | ------------: | -------------------------: | -----------------------: | -------------------: | -------------------: | ------------------------: |
| Cold      |       4.623 s |                      7,118 | 30.6 / 34.8 / 4,264.1 ms |         4.0 / 5.2 ms |     29.96 / 32.23 ms |              46,967,132 B |
| Warm      |       1.846 s |                      8,141 |   17.8 / 18.7 / 137.2 ms |         3.9 / 6.1 ms |     11.76 / 14.27 ms |              46,946,360 B |

The cold run included a 4.26-second gap. The samples do not establish its cause or a sustained 60 fps. GPU measurements are 356/408 non-disjoint samples; peak process RSS and VRAM are unmeasured. **Integrated-GPU qualification remains open:** there was no integrated GPU on this host. Run cold and warm on a separately identified integrated adapter, record its driver, actual backing and quality, and retain its independent receipt.
