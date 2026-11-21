# World hashing: equivalence and benchmark

`world.hash()` still means `hashSnapshot(world.snapshot())`: canonical JSON key order, entity slot order, allocator/free-list order, resource values, tick and seeded PRNG state, hashed by the original UTF-16 low-byte-first FNV-1a-64. Events retain their separate digest. Neither the reference encoder nor the FNV implementation changed.

The old path cloned and serialized every value even when unchanged. A hash now reads the same live slots and resources as a snapshot, but reuses previously validated canonical text for unchanged values. A weak-keyed entry contains a detached checked copy and its encoding. The live value must **structurally equal** that copy on this call; matching object identity, tick number, or absence of an `add`/`setResource` call is not a valid cache hit. This catches edits through a retained component, query view or resource reference. A miss runs the normal checked clone/encoder, preserving diagnostics for illegal live writes. `snapshot()` still returns independent data.

The optimization saves deep allocations, repeated key sorting and encoding; it still walks mutable data and hashes the full canonical stream on every call. The trade-off is retaining checked copies and text for cached object values. It is not a dirty-bit system, frame-rate estimate, change to replay pins or optimization of action-runtime commits.

## Reproduce

From a built workspace:

```powershell
node scripts\bench-world-hash.mjs
node scripts\bench-world-hash.mjs --full-check
```

The first command runs the original NULL MERIDIAN route's first **600 ticks**, seed `null-meridian-1`, at 60 Hz. All four arms re-run the same game/plugin/input/harness in one Node process. Only the hash implementation (old `hashSnapshot(world.snapshot())` vs `world.hash()`) and harness per-tick setting vary. Scene/input file reads, event digesting and output comparisons are outside the measured region. Each arm gets one full warm-up and three measured runs, reversing order on alternate rounds. The script counts hash calls and compares final hash, event digest and **every per-tick hash**, not just a timing number.

Sample on Windows x64, Ryzen 7 5800X, Node v25.6.0; wall-clock milliseconds:

| 600-tick arm     | Calls |               Before (samples; median) |            After (samples; median) |
| ---------------- | ----: | -------------------------------------: | ---------------------------------: |
| Final only       |     1 |         28.89, 30.98, 31.09; **30.98** |     24.58, 33.65, 34.63; **33.65** |
| Per tick + final |   601 | 2110.53, 2362.87, 2273.06; **2273.06** | 747.55, 762.78, 776.50; **762.78** |

The per-tick median was **2.98× faster** on this host. The final-only control was 2.67 ms slower; it has no earlier encodings to reuse. All 600 entries matched: final `105d00a1013eb0d2`, trajectory `e89343c22c743bc9`, events `a9ea8a540c993d3e`. These measurements are not a CI threshold.

`--full-check` is an equivalence check, not a warm benchmark. It runs all four arms over the complete **8,217-tick** win route, requires the original named mission assertions (including `level.completed` on tick 8153), and checks the shipped final and trajectory pins. All 8,217 individual reference/optimized hashes matched: final `7a8eeb4d3cdd4dae`, trajectory `472e64afc4a7ab21`, events `30fc3953cb3d0f75`. Per-tick arms each made **8,218** hash calls. No input, threshold or expectation was re-recorded.

Independent headless runs also compared every hash on the other three shipped win routes, using the authored input files and the game tests' seeds. The original final and trajectory pins matched:

| Game          | Compared ticks | Final              | Trajectory         |
| ------------- | -------------: | ------------------ | ------------------ |
| Coyote Gap    |            400 | `d813e4e19db7444d` | `79d373c4785825ca` |
| Server Vault  |            960 | `cb0f07007ad8608a` | `faab0cbc899d293c` |
| Sector Breach |            600 | `f86540b793f071a3` | `1ce5508ff97c0b75` |
