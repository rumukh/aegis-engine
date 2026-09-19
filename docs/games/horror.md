# NULL MERIDIAN

A fourth, explicitly authorized Aegis game: first-person survival horror inside an abandoned
orbital facility. There are **no guns, combat upgrades, invisible timed kills or timer-only
victories**. The threat is a damaged industrial rescue responder, not a recognizable existing
film/game creature. It follows visible light and audible movement, investigates last-known
positions, and can be evaded through the station's interconnected rooms.

## Play and controls

Build from the repository root with `npm run build`, then `npm run play`; choose **NULL MERIDIAN**.
The static exporter includes the same game at `play/horror/`, using the same scene and composed
`@aegis/game-horror#nullMeridianPlugin`.

| Keyboard / mouse    | Standard controller | Action                                        |
| ------------------- | ------------------- | --------------------------------------------- |
| WASD / mouse        | Left / right stick  | Move / look                                   |
| E, or primary click | A                   | Interact; hold while operating machinery      |
| Q                   | X                   | Cycle the labeled option at a selector        |
| C (hold)            | B (hold)            | Crouch, lower eye height, move quietly        |
| Left Shift (hold)   | LB (hold)           | Sprint; louder and limited by stamina         |
| F                   | Y                   | Toggle flashlight; darkness reduces detection |
| P / R               | Menu / View         | Pause / restart from the docking airlock      |

Controller input uses the shared neutral-arm contract: release controls after connection,
refocus, pause/resume or restart. Browser audio still requires a user gesture. Every necessary
clue, objective, selected option and denial is readable without audio. Previously read evidence
can be inspected again without duplicating mission rewards.

The browser proof samples a virtual standard controller at `navigator.getGamepads`, not a
private gameplay injection hook. It exercises both sticks, crouch, sprint, flashlight, X selector
changes, A machinery holds, Menu/View and held-button neutral rearming in running simulation.
Controller gameplay is intentionally suppressed while paused; exact paused route stepping uses
keyboard/mouse. Physical-controller testing remains a separate manual check.

The live server shares one single-player world between viewers. Fresh gameplay input takes
control; another page's neutral polling or held-input resends cannot steal it. Page-local sequence
numbers and event cursors prevent an older preview from silently blocking a newly opened page.
The visible input hint distinguishes control, observation, pause, focus and denied mouse capture.
See [live browser input streams](../api/live-input-clients.md). Static builds retain independent
worlds per page; the user confirmed keyboard movement and mouse look on the frozen static review.

When caught, the view dims over one second and a persistent **YOU WERE CAUGHT** dialog offers
an actual Restart button. Mouse capture is released and the button receives focus; R and
controller View remain restart commands. Reduced-motion preference applies the dim immediately.
The camera stays upright, the game does not restart automatically, and this presentation does
not alter the authoritative catch, collision or replay hashes.

Successful extraction now opens an **18-second, in-engine evacuation cutscene**: the capsule
hatch closes, the independent capsule separates from the east docking collar, and the station
recedes against the existing gas giant. Captions confirm that the crew archive is safe before
the view fades to **CLEAR OF NULL MERIDIAN**, with Play again and All games controls.
Skip (or Escape) goes directly to this completion screen. Pause and Mute remain accessible;
reduced motion goes straight to the still completion screen. R / controller View restarts
with the normal neutral-input rearm. A held interaction cannot operate the ending controls.

This is an isolated presentation scene, not a new mission, teleport or gameplay camera change.
The same `level.completed` event and canonical hashes remain authoritative. Its local clock
stops for cutscene/session pause and hidden tabs; returning to the page does not fast-forward.
The existing airlock sound starts at completion; the original separation voice is reassigned,
once, to the cutscene's four-second separation beat. Skip, mute, delayed unlock and reduced
motion do not replay missed dialogue. Pause stops active speech rather than resuming a partial
line; the timed text remains available. Rejoining a completed live run restores the final
screen without replaying the cinematic or historical speech. Other games remain opt-out.

`assets/build-ending.mjs` cooks only `generated/evacuation-ending.glb`, a separate animated
exterior/capsule set using the existing orbital geometry and material maps. It does not rebuild
or replace the accepted facility, responder, rings, textures or original visual inventory.
`assets/ending-provenance.json` fingerprints the new source/output. This additional asset and
its existing dependencies are included by the production loader and static exporter within
the unchanged 64 MiB encoded budget.

## Mission structure

1. Investigate the docking report and maintenance slate; recover the auxiliary fuse.
2. Manually release the service bulkhead and physically isolate the failed rescue bus.
3. Route auxiliary power to the intact **MEDICAL / ARCHIVE** feeder. The rescue and habitat
   circuits are unsafe. Wrong choices explain the problem and preserve the fuse.
4. Recover the infirmary's visitor authorization; use it to retrieve the archive black box.
   Restoring power awakens the responder and opens two archive approaches.
5. Follow the recorder's isolation procedure: close **COOLANT RETURN**, not capsule pressure.
6. Reach observation, transmit to the **INDEPENDENT CAPSULE**, then physically board and seal
   the east evacuation capsule. Calling the compromised rescue authority instead summons a
   real search to the uplink, not automatic damage. The choice remains correctable.

The room labels and machine prompts carry these decisions. The maintenance and infirmary loops,
solid machinery and two archive portals provide different approaches and sight breaks.
Walk speed is 2 m/s, crouch 1.1 m/s, sprint 3.8 m/s with six seconds of stamina and a recovery
threshold. The responder walks at 1.15 m/s, searches at 1.5 m/s and pursues at 2.65 m/s.
Seeing the visitor builds suspicion instead of immediately killing them. A catch requires clear
sight, close physical proximity and a 48-tick warning interval during which the visitor can move.

**Duration is not yet accepted.** The design target is an 8-12 minute uncoached first play,
including investigation, route discovery and evasion. The scripted foreknowledge route completes
on tick 8153 at 60 Hz: **135.9 seconds**, without waiting to inflate its duration. That is a
mechanical route measurement, not evidence that first-play tension or duration meets the target.
An uncoached human playthrough remains the acceptance gate.

## Deterministic authoring contract

`games/horror/levels/null-meridian.scene.json` is the authority for the floorplan and named
anchors. There is no disconnected tilemap duplicate. It uses FPS coordinates: +X east, +Z north,
+Y up; 1 m cells centered on integers; origin `(0, 0)`; row 0 at z=40. Floor height is 0 and
ceiling height 3.6 m. Gameplay collision is the extruded 31 by 41 grid.

| Door cells | Physical portal                           | Opens after               |
| ---------- | ----------------------------------------- | ------------------------- |
| D          | Service, centered x=6, z=24               | Manual service release    |
| P          | Power/spine, x=12, z=29                   | Auxiliary power           |
| A          | Archive west x=18, z=22; south x=24, z=20 | Auxiliary power           |
| O          | Observation, x=15, z=34                   | Correct coolant isolation |
| E          | Evacuation, x=24, z=37                    | Independent uplink        |

`HorrorMission` is attached to `mission`; `HorrorPlayer` and `HorrorStatus` to `player`;
`HorrorThreat` to `responder`. Authoritative controls, interaction progress, selected routes,
stamina, search paths, objective state and subtitle text are world data. Rendering observes
them; asynchronous assets and audio never control mission progression.

## Executable evidence

```powershell
node packages\cli\bin\aegis.mjs validate games\horror\levels\null-meridian.scene.json
node packages\cli\bin\aegis.mjs run games\horror\levels\null-meridian.scene.json --ticks 8217 --input games\horror\play\null-meridian.input --json
node packages\cli\bin\aegis.mjs run games\horror\levels\null-meridian.scene.json --ticks 3900 --input games\horror\play\caught.input --json
node packages\cli\bin\aegis.mjs run games\horror\levels\null-meridian.scene.json --ticks 1800 --input games\horror\play\locked.input --json
node packages\cli\bin\aegis.mjs test
npm run verify
```

The three compiled gametests carry named gameplay assertions. The win then checks deliberately
recorded final/trajectory hash literals (8217 ticks, seed `null-meridian-1`, 60 Hz). The CLI
record/replay path uses the actual authored input file. Full-world history is **not** retained;
bounded fixtures and live invariants prove the critical behavior without thousands of grid
snapshots.

All eleven controls are mounted in existing solid wall/machinery faces rather than freestanding
pass-through kiosks. For example, the arrival interaction point at `(19.45, 0, 6)` lies just
outside the ingress east wall face at x=19.5. The revised route visits their actual approaches
and genuinely provokes then evades the responder: chase at 5038, search at 5318, evasion at
5677, coolant at 6085, uplink at 7332, extraction at 8153. The floorplan and physics did not
change. The explained hash re-pin records the approved anchor/route changes and explicit
ending-aware `HorrorStatus.musicPhase`, not an unexplained renderer-induced gameplay drift.

The Vitest suite covers missing evidence, all unsafe power routes, recoverable selector errors,
wrong nearby panels, through-wall/distant/back-facing interaction, interrupted holds, repeated
input, replayable text, post-death/post-extraction actions, sight occlusion with a positive
control, quiet movement, audible sprinting, diagonal speed normalization and real exhaustion.
Mutation checks remove all systems, run zero ticks, disable interaction, and disable threat AI.
The three long compiled acceptance specs run in awaited Node children: the same full per-tick
hashing and assertions execute without blocking Vitest's worker RPC for tens of seconds.
The root test setup also yields native I/O between synchronous tests so their RPC replies do
not remain queued across an entire CLI suite. Node high-resolution timing measurements run
after the parallel worker pool, with their original budgets unchanged; this timing phase still
runs on hosted Windows, where only the existing browser phase is excluded.

A spatially initialized evasion fixture then uses **only inputs**, not teleports: chase at tick
33, search after losing sight at 367, return to patrol at 734. A live invariant bounds every
movement step below 0.064 m and keeps the visitor alive. This demonstrates the escape mechanic;
it is not a claim about how frightening the rendered encounter feels.

## Presentation acceptance

The requested direction is grounded, readable station horror, with original environment assets,
a physical rescue-suit silhouette, practical light pools, a controllable flashlight, spatial
machinery/footsteps, sparse dialogue and a gas-giant observation view. The target is 2560 by 1440
at 60 fps on RTX 4070 Ti SUPER, with a separate higher-quality screenshot tier.

The optical-baseline art, evacuation ending and approved SFX close over **37 visual files
(40,106,653 bytes)** and **30 audio files (1,505,787 bytes)**: **67 files, 41,612,440 bytes**,
within the unchanged 64 MiB presentation limit. Retained recipes, sources,
file fingerprints and an independent byte-for-byte visual rebuild accompany the assets.
The original 36-file visual inventory remains unchanged; the added evacuation model is recorded
separately in `ending-provenance.json`.
The current cooking proof records Node 25.6.0 and three.js 0.169.0; it is not a claim that
rebuilding with an arbitrary toolchain produces identical media.

The soundscape includes eight voiced lines, room/vent/hull beds, physical machinery, four
visitor footstep variants and three responder variants. **There is no musical score.**
Authorized score generation failed without producing a native audio file; the explicit
failure/provenance record is retained under `assets/audio`, and offline score recipes are not
declared as runtime assets. Dialogue shares one voice group, and master headroom is applied once.

The user approved three original nonmusical horror gestures on 2026-09-19. Additive mono layers
place strained material inside maintenance machinery, dry clicks behind the infirmary wall, and
respiration on the actual responder. Their 37/41/47-second loops contain at least 85% authored
quiet, use gains 0.30/0.26/0.22, and fade out over 0.2 seconds when `HorrorStatus.musicPhase`
leaves `explore`. All 27 existing audio files, footsteps and warning bindings are unchanged.
The existing 0.65 master headroom is not applied twice. Added decoded PCM is 24,000,000 bytes
at 48 kHz, bringing audio PCM to 64,557,712 bytes; these are not browser-memory or VRAM totals.
Approval, hashes and reproducible edit/encode recipes are under `assets/audio/source/horror-pass/`.

Actual recorded game output includes a real clue with non-silent chitter underneath and a
subsequent physical catch: pursuit at tick 4352, warning at 4469, caught at 4516, preserving
48 inclusive warning ticks. All new layers stopped about 1.75 seconds before the audible warning.
Mute and paused/restart intervals measured zero master output. These observations and CPU
waveform checks are not human intelligibility or final whole-game mix approval. The recorder's
later redundant scenario failed to reacquire the mouse before resetting the persistent caught
dialog, and graceful shutdown needed an owned-process fallback; completed measurements are
retained separately from that failed runner exit. Media-container duration is not assumed to
preserve disconnected-silence intervals on the AudioContext clock.

Precise browser route proofs use paused single-step input, which intentionally suppresses audio.
A separate unpaused phase exercises ambience, flashlight and walking cues before resetting for
the exact route. Source playback/decode checks do not replace human listening. Likewise, a
chase event or projected location does not prove the responder appears in a screenshot: a
separate illuminated approach checks its distance and screen position before the physical catch.

The high preset retains two shadowed lights, ACES, restrained bloom and LDR reflections, but
does not enable SSAO. Photo raises shadow/MSAA quality and permits a 4K backing-pixel budget;
it is not a 60 fps preset. A library-local image-source cache preserves separate texture
sampling while avoiding repeated decoded glTF images. An unchanged v7 scene measured
104 sources down to 18 (about 928 to 133 MiB of estimated RGBA8+mips); that is not total GPU
residency. A later, less-loaded 1440p window measured approximately 47.6 fps, **not 60 fps**.
Cold-loading and heavily contended windows are recorded separately rather than averaged into
a favorable performance claim.

A pre-follow-up v9 **active pursuit** sample retained 2560 by 1440 backing resolution, high quality,
both shadowed lights and unmuted audio on the RTX 4070 Ti SUPER. It recorded 204 frames in
4.0185 seconds (about **50.8 fps**), with frame gaps p50 17.7 ms, p95 35.2 ms and p99 53.1 ms.
The simulation advanced 233 ticks and the living visitor moved 14.76 m during that sample.
This is an actual moving/threat workload, not a paused-scene or tiny-fixture claim, and it
still does **not** establish sustained 60 fps. It predates the live input ownership fix and
v10 optical repair; it is retained as comparison evidence, not a new-revision benchmark.

A subsequent bounded study retained v9 art, the same tick-3140 prefix, full lighting/quality,
active pursuit and unmuted audio. Three static controls, three instrumented static windows
and three fixed-live controls measured display-gap means of 16.6800-16.6808 ms, approximately
60 Hz over each four-second window. The verified RTX whole-composer GPU window had 240 valid
timer queries, no disjoint samples, mean 4.66 ms and p95 6.01 ms. The first uninstrumented
static control requested hardware but omitted its vendor readout; later device measurements
are retained rather than inventing evidence for that first run. The earlier 50.8 fps result
was not reproduced under the later shared-machine load. No performance patch or quality
reduction was justified, and these short windows still do not guarantee sustained full-mission
1440p60.

**AAA presentation, sustained 1440p60, final audio mix and uncoached first-play acceptance are
not established by gameplay tests.** They require the integrated rendered build, actual backing
resolution/performance measurements, audible review and explicit human review. Asset/source
provenance and measured limits must remain attached to that review rather than inferred from
feature names.

The bounded v10-r2 optical repair replaces the broad white visor reflection with a smooth,
tinted curved surface and the high-contrast striped rings with a continuous muted density
annulus. Only two runtime models change and one small image is added; 33 previous runtime files,
the scene, rigs, clips, lighting and camera transforms remain unchanged. The first visor
candidate was rejected for an X-shaped highlight despite reduced clipping. The corrected
candidate passed identical-world, fixed-pose and lateral-view comparisons and was accepted by
the coordinator for those two defects only—not as overall AAA, human mix, gait or performance
signoff. `verify-rebuild.mjs --scope optics` rebuilds those three files and hash-checks, rather
than rebuilding, the remaining 33.

Human review confirmed both movement and mouse look on the independent static build and
described the atmosphere positively after a real catch. The request for a more obvious failure
ending prompted the opt-in loss dialog above; it is not blanket visual, audio-mix, gait or
8-12 minute pacing approval.
