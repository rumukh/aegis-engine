# NULL MERIDIAN full-route benchmark

From a clean revision, `npm ci && npm run build`, close other GPU-heavy workloads and run:

```sh
node scripts/bench-horror-route.mjs --device target --renderer "RTX 4070 Ti SUPER" --driver "<installed version>" --out "<outside-checkout>/rtx.json"
```

The target workload requires a real 4070 Ti SUPER and a measured 2560×1440 backing buffer with the shipped high pipeline. On a machine with verified integrated graphics, identify the actual adapter and its driver; for example, use `--device integrated --renderer "Iris Xe" --driver "<installed version>" --resolution 1280x720 --quality standard --out "<outside-checkout>/integrated.json"`. The driver and device class are operator declarations; also inspect the measured WebGL renderer and CDP device inventory. A virtual screen does not establish an integrated GPU. Software controls require `--device software` and must not be counted for either class.

Both runs traverse the entire winning `.input` at real-time fixed ticks in the normal live player; only input is injected. Loading is navigation-to-first-mounted-presentation, not launch-to-menu. Cold means a new browser profile, **not** a flushed OS/driver cache. Warm repeats in the same browser, profile and origin with a new page and fresh world; normal HTTP caching rules still apply. Timing starts at tick zero and covers active gameplay through extraction (`level.completed` at 8153); the ending film is not part of the route. Reject missing completion, death, mismatched resolution/renderer or exchange failures.

Read frame gap p95/p99 separately from CPU wall time inside the render call and sampled WebGL GPU elapsed queries. Queries need extension support; invalid/disjoint samples are not successful GPU measurements. The sampled peak is **renderer V8 used heap during the route**, not whole-process memory or GPU VRAM. Missing counters are `null`, not zero. Preserve both conditions and raw workload metadata; do not use a short pursuit, software rendering or a mean to claim sustained 1440p60.
