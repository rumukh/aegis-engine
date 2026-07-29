/**
 * A minimal Chrome DevTools Protocol driver: the only way this package reaches a real browser.
 *
 * It speaks CDP over Node's built-in `WebSocket` against whichever Chromium-family browser is
 * installed, so it adds no dependency (ADR-0005: three.js stays the only third-party runtime
 * dependency). It knows nothing about games, scenes or scripts — it launches a browser, opens a
 * page, dispatches real key and mouse events, evaluates expressions and takes screenshots.
 *
 * It lives in its own module because two things need it and they must not drift apart: the
 * screenshot capture, which drives a scripted playthrough, and `browser-playability.test.ts`,
 * which measures what a human's frame budget actually is. A second private copy of a browser
 * driver is exactly the kind of thing that rots quietly in one of its two homes.
 * @packageDocumentation
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';

/** Where a Chromium-family browser might live on this machine. */
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** The first browser executable that exists on this machine. */
export function findBrowser(): string {
  const override = process.env['AEGIS_BROWSER'];
  if (override !== undefined && override !== '') return override;
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error(
    '[aegis:render-three] no Chromium-family browser found. Install Chrome or Edge, or pass a ' +
      'path via AEGIS_BROWSER.',
  );
}

/** A minimal Chrome DevTools Protocol session over one WebSocket. */
/**
 * Deadline on a single CDP command's *reply*, in milliseconds.
 *
 * Declared here rather than as a literal default on {@link CdpSession.send} because it is one of
 * the deadlines a per-test budget has to contain, and a number that only exists inside a function
 * signature cannot be included in anyone's arithmetic. See the doc comment on `send` for what it
 * is and — more importantly — for what it is measured *not* able to tell you.
 */
export const TRANSPORT_TIMEOUT_MS = 30_000;

/**
 * How many recent successful round trips {@link CdpSession} keeps in order to describe itself when
 * one of them eventually does not come back. Bounded because a render-loop page can issue thousands
 * and the question this answers — "was this session healthy a moment ago?" — needs only the recent
 * shape, not the whole history.
 */
export const ROUND_TRIP_HISTORY = 24;

/**
 * How often the event-loop lag sampler wakes, in milliseconds.
 *
 * Small enough that a lag figure is a measurement rather than a rounding of this interval, and
 * large enough that the sampler itself is not the load. A sample that fires late by more than this
 * interval is by definition time this process spent not being scheduled or not returning to the
 * loop.
 */
export const LAG_SAMPLE_INTERVAL_MS = 50;

/**
 * How late a deadline has to fire before it is reported as *late* rather than as noise.
 *
 * A timer is never exact: it fires on the first loop turn at or after its due time, so a few
 * milliseconds of overshoot is normal and says nothing. One second is twenty sampler intervals and
 * is far outside anything observed on a healthy loop; the figures that motivated this constant are
 * measured in *seconds* (see {@link describeDeadline}).
 */
export const LATE_OVERSHOOT_MS = 1_000;

let lagTimer: ReturnType<typeof setInterval> | undefined;

/**
 * One reading of the loop's health.
 *
 * `cpuMicros` is cumulative process CPU time (user + system) at the moment of the sample. Cumulative
 * rather than per-interval so that a *missed* interval is still covered: the difference between two
 * surviving samples spans the gap between them, which is exactly the period a stalled loop takes no
 * samples in and is exactly the period we need to attribute.
 */
interface LagSample {
  at: number;
  lateBy: number;
  cpuMicros: number;
  /**
   * System-wide cumulative CPU times, on every {@link SYSTEM_CPU_SAMPLE_EVERY}th sample only.
   * Used as the *anchor* preceding a measurement window, never as both of its endpoints — see
   * {@link maxLagSince}.
   */
  sys?: { busyMs: number; idleMs: number };
}

/**
 * How many lag samples apart a **system-wide** CPU reading is taken.
 *
 * `os.cpus()` is not free. Measured on this 16-core box, 20 000 calls each: **736.5us** per call
 * against **1.3us** for `process.cpuUsage()` — a factor of 550, because it allocates one object per
 * core. At the 50ms lag cadence that would be **14.7ms of CPU per second of wall clock**, ~1.5% of
 * a core, continuously, for the life of the process — burnt *inside the instrument whose entire
 * subject is CPU starvation*. An instrument that perturbs its own subject is worth less than none,
 * so the system reading is taken every tenth sample: ~0.15% of a core.
 *
 * 500ms is ample for what this now does, but **not for the reason first written here.** The original
 * comment argued that a 500ms cadence still owes 50-80 readings over a 25-40 second stall. That is
 * arithmetic about a healthy loop and the windows in question are stalled ones, which take *no*
 * samples while they are stalled — the figure was true and irrelevant, which is a worse failure than
 * being wrong. See {@link maxLagSince}: the decimated samples now supply only the **anchor** taken
 * before the window, and the closing reading is taken live, so this cadence bounds how stale the
 * anchor may be (=500ms) rather than how many readings a stall contains (which is ~0).
 *
 * Cumulative rather than per-interval, for the same reason as `cpuMicros`: a delta across a stall
 * spans the stall itself, which is exactly the period a per-interval field would be blind to.
 */
export const SYSTEM_CPU_SAMPLE_EVERY = 10;

/**
 * Cumulative busy and idle CPU time across every core, in ms.
 *
 * Validated on this box before being relied on, because a counter that never advances would report
 * `0% busy` and be read as *"the box was idle"* — the empty-instrument failure this repository has
 * hit repeatedly, in the one place it would invert a conclusion. Two arms, 2s each: saturating a
 * single core read **50.9%** system-busy against **41.3%** while sleeping, on a box already loaded
 * by sibling sessions. One core of sixteen predicts a 6.3-point rise; the observed rise was 9.6.
 * The counters advance and the arms are distinguishable, which is all this is asked to do.
 */
function systemCpu(): { busyMs: number; idleMs: number } {
  let busyMs = 0;
  let idleMs = 0;
  for (const core of cpus()) {
    const times = core.times;
    idleMs += times.idle;
    busyMs += times.user + times.nice + times.sys + times.irq;
  }
  return { busyMs, idleMs };
}

/** Busy share of the whole box between two cumulative readings, or `undefined` if unmeasurable. */
function systemBusyRatio(
  from?: { busyMs: number; idleMs: number },
  to?: { busyMs: number; idleMs: number },
): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const busy = to.busyMs - from.busyMs;
  const idle = to.idleMs - from.idleMs;
  const total = busy + idle;
  return total > 0 ? busy / total : undefined;
}

/**
 * Open a window over which the whole box's CPU busy share will be measured; call the result to
 * close it.
 *
 * The closer answers `{ ratio, windowMs }` and deliberately never a bare number. `os.cpus()` is
 * cumulative since boot, so a ratio is a quotient of two deltas and says nothing without the span
 * they were taken over: two readings 3ms apart divide noise by noise and produce a number that
 * reads exactly like a result. This repository has now needed that denominator three times --
 * landing #24 added `of ~N due` to the lag sampler after `2 sample(s)` was read as reassurance,
 * landing #26 added `ratioFromMs` after an anchor of unbounded staleness diluted a ratio to 0.40 in
 * the one fork it exists to resolve, and this is the third. Twice it was fixed by writing a better
 * comment; making the window length structurally inseparable from the ratio is the repair that does
 * not depend on the next caller having read either.
 *
 * `ratio` is `undefined` rather than `0` when the counters did not advance -- an unknown that says
 * so, because `0` means "the box was idle" and would invert the conclusion.
 *
 * `busyMs` is the raw numerator -- the busy-time delta summed across every core -- and it is
 * reported alongside the quotient rather than folded into it, because THE QUOTIENT SATURATES AND
 * THE NUMERATOR DOES NOT. On a box pinned at 100% the idle delta is exactly 0 over every window, so
 * `busy / (busy + 0)` is exactly `1` however long the window was: measured here at 0ms of idle
 * across spans of 500/1100/1000/4000ms, which is arithmetic rather than a sample. The numerator over
 * those same four windows read 8984/24118/16755/65673ms. Any caller asking "are these really three
 * independent measurements, or one snapshot plumbed to three names?" must ask it of `busyMs`: a
 * reused snapshot collapses the numerator, and nothing else does.
 */
export function startSystemLoadWindow(): () => {
  ratio: number | undefined;
  windowMs: number;
  busyMs: number;
} {
  const from = systemCpu();
  const openedAt = Date.now();
  return () => {
    const to = systemCpu();
    return {
      ratio: systemBusyRatio(from, to),
      windowMs: Date.now() - openedAt,
      busyMs: to.busyMs - from.busyMs,
    };
  };
}

const lagHistory: LagSample[] = [];

/**
 * How many lag samples are kept.
 *
 * At {@link LAG_SAMPLE_INTERVAL_MS} this is 200 seconds of history, which covers the longest
 * deadline in this package with room to spare. Bounded because the sampler runs for the life of the
 * process and an unbounded array would be a slow leak inside the instrument that measures leaks.
 */
export const LAG_HISTORY = 4_000;

/**
 * Start sampling this process's event-loop lag, if it is not already running.
 *
 * Deliberately process-wide rather than per-session: the quantity is a property of *this Node
 * process*, not of any one socket, and a per-session copy would report a different number for two
 * sessions starved by the same thing. Idempotent, and the interval is `unref`'d so it can never by
 * itself hold the process open.
 */
export function startEventLoopLagMonitor(): void {
  if (lagTimer !== undefined) return;
  let due = Date.now() + LAG_SAMPLE_INTERVAL_MS;
  let tick = 0;
  // A baseline reading taken synchronously at start, not on the first interval. Without it the
  // monitor has no system-CPU anchor for its first LAG_SAMPLE_INTERVAL_MS, and a window opened
  // immediately after starting it -- which is exactly what `beforeAll` does -- would have no
  // endpoint before it and report `systemRatio` unmeasured. `lateBy` is 0 because it is not late.
  //
  // NO TEST CONTROLS THIS LINE, and that is stated rather than left to be discovered. A mutation
  // deleting the `sys` reading below was run against the whole diagnostics spec and it stayed GREEN
  // at 37/37 -- correctly, because the monitor is a process-wide singleton that those cases inherit
  // with minutes of history already in it, so they never exercise the first interval at all. The
  // claim here is proved by construction instead: `setInterval` does not fire until one interval has
  // elapsed, so without this push there is no reading of any kind before then. Treat it as unpinned
  // and do not delete it on the strength of a green suite.
  const base = process.cpuUsage();
  lagHistory.push({
    at: Date.now(),
    lateBy: 0,
    cpuMicros: base.user + base.system,
    sys: systemCpu(),
  });
  lagTimer = setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const sys = tick % SYSTEM_CPU_SAMPLE_EVERY === 0 ? systemCpu() : undefined;
    tick += 1;
    lagHistory.push({ at: now, lateBy: now - due, cpuMicros: cpu.user + cpu.system, sys });
    if (lagHistory.length > LAG_HISTORY) lagHistory.shift();
    due = now + LAG_SAMPLE_INTERVAL_MS;
  }, LAG_SAMPLE_INTERVAL_MS);
  lagTimer.unref?.();
}

/**
 * The worst event-loop lag observed at or after `sinceMs`, how many samples that is over, how many
 * were **due**, and what share of the window this process actually spent on a CPU.
 *
 * The sample count is returned rather than folded away because a maximum over **zero** samples and
 * a maximum **of** zero render identically as `0ms` and mean opposite things — the first is an
 * instrument that never ran. Callers print both.
 *
 * `expected` was added after `windows-latest` run 30371952350 reported `30102ms over 2 sample(s)`
 * for a 30-second window. A 50ms sampler owes ~600 samples there, so **the sampler's own miss rate
 * is a measurement**: 2 of 600 says the loop was stopped, not merely busy. Without the denominator
 * `2 sample(s)` reads as a small number of readings rather than as evidence.
 *
 * `cpuRatio` is the fork nothing else in this file could resolve. It is CPU time (user + system)
 * divided by wall time across the window, so:
 *
 * - **~1** — the process was running flat out. Something synchronous, or genuine saturation. Ours.
 * - **~0** — the process was *not scheduled*. Something else held the cores; this field cannot say
 *   what, and {@link startSystemLoadWindow} exists because guessing here was a shipped defect.
 *
 * "Event loop lagged 30 seconds" is consistent with both, and they have opposite fixes. It is
 * `undefined` only when the monitor has never taken a reading — see the note on anchoring below,
 * which applies to this field in exactly the same way and for exactly the same reason.
 *
 * `systemRatio` exists because `cpuRatio ~ 0` **still does not say the box was oversubscribed**, and
 * the message built on it claimed exactly that for three landings: *"it was NOT SCHEDULED, so the
 * box is oversubscribed by something outside this process"*. `cpuRatio` measures **this process**.
 * Nothing here measured the box, so the clause after "so" was an inference wearing a measurement's
 * clothing — this repository's own defect, inside the diagnostic written to stop it. The two cases
 * are distinguishable and have opposite next steps: node ~0 with the box saturated is genuine
 * oversubscription, and node ~0 with the box **idle** refutes CPU contention outright and sends you
 * to look at I/O, a lock, or the socket. Same shape and same reason as `cpuRatio` itself, one level
 * out. `undefined` below two system-carrying samples, for the same reason.
 *
 * **That repair was half done, and the surviving half has since been refuted by measurement.** It
 * gated *"the box is oversubscribed"* on a real box reading and left *"by something outside this
 * process"* standing in the saturated branch — a second claim, about attribution rather than about
 * load, which `systemRatio` cannot support either: `os.cpus()` counts **every** process on the
 * machine, and the browser and dev server this suite starts are among them. `windows-latest` run
 * 30390018561 then measured the box at **6% before anything of ours exists** and **100%** during the
 * run, so the saturation is ours and the clause was false as well as unsupported.
 *
 * **And saturation does not by itself explain a stall, which is the more useful half.** The same run
 * measured `ubuntu-latest` — same tree, same instrument, same demand, and green — at **88% busy with
 * a 23ms worst lag over 739 of ~745 samples**, against `windows-latest` at **100% with 74823ms over
 * 1284 of ~16830**. A 3250x difference in starvation across a 12-point difference in box load is not
 * a CPU-contention shape. Report what the counters say; do not let this field name a cause.
 *
 * **Both ratios are measured from an anchor to a live reading, not between two samples inside the
 * window, and the first design of this was wrong in the one condition it exists for.** Taking both
 * ends from samples *inside* the window makes the ratio undefined precisely when it is needed: a
 * blocked loop takes no samples at all while it is blocked, so a stall yields one overdue sample
 * when it ends and never two. Measured against the real CI shape rather than argued —
 * `windows-latest` run 30380984122 took **2, 3, 4 and 5 samples of ~600-850 due** across its four
 * transport failures, and at one system reading per {@link SYSTEM_CPU_SAMPLE_EVERY} samples those
 * windows expect **0.3** readings. Every one would have printed `UNMEASURED`. A local control caught
 * it (`expected undefined to be defined` after a deliberate synchronous spin) before this shipped a
 * second empty instrument, and then caught the same defect in `cpuRatio`, which had been computing
 * between two in-window samples since it was added and is blind in the same way for the same reason.
 *
 * So the start endpoint is the latest reading taken at or **before** `sinceMs` — which exists
 * whenever the monitor has been running, no matter how starved the window itself is — and the end
 * endpoint is taken **live** here. `os.cpus()` costs ~736us and is called once per invocation, on a
 * path that is already diagnosing a failure.
 *
 * **The price is dilution, it is unbounded, and `ratioFromMs` is how you see it.** The ratios cover
 * `[anchor, now]`, not `[sinceMs, now]`. While the sampler is healthy the anchor is at most
 * {@link LAG_SAMPLE_INTERVAL_MS} stale for `cpuRatio` and `SYSTEM_CPU_SAMPLE_EVERY x` that (=500ms)
 * for `systemRatio` — but *the anchor is only as fresh as the last sample the sampler managed to
 * take*, so a stall immediately **before** the window pushes it back by the length of that stall.
 * An earlier draft of this comment claimed the 50ms/500ms bound unconditionally; a local control
 * refuted it by measuring an idle window straight after a 2.5s synchronous spin and reading
 * `cpuRatio` **0.40** instead of ~0 — the anchor predated the spin, so the spin was inside the
 * window. That is a real misattribution risk in the one fork this field exists to resolve, so it is
 * reported rather than bounded: `ratioFromMs` is the earliest moment **either** ratio covers, and a
 * reader comparing it to `sinceMs` can see exactly how much of the answer is about the period before
 * the question.
 */
export function maxLagSince(sinceMs: number): {
  maxMs: number;
  samples: number;
  expected: number;
  cpuRatio?: number;
  systemRatio?: number;
  ratioFromMs?: number;
} {
  let maxMs = 0;
  let samples = 0;
  let anchor: LagSample | undefined;
  let firstInWindow: LagSample | undefined;
  let anchorSys: LagSample | undefined;
  let firstSysInWindow: LagSample | undefined;
  for (const sample of lagHistory) {
    if (sample.at < sinceMs) {
      // Keep the LATEST reading taken before the window opened. See the note on anchoring above:
      // this is the only endpoint a stalled window is guaranteed to have.
      anchor = sample;
      if (sample.sys !== undefined) anchorSys = sample;
      continue;
    }
    samples += 1;
    if (sample.lateBy > maxMs) maxMs = sample.lateBy;
    firstInWindow ??= sample;
    if (sample.sys !== undefined) firstSysInWindow ??= sample;
  }
  const now = Date.now();
  const expected = Math.max(0, Math.round((now - sinceMs) / LAG_SAMPLE_INTERVAL_MS));
  // A window that has not elapsed yet cannot be measured, and neither ratio may answer for it. Zero
  // would read as "this process was never scheduled" and ~1 as "it ran flat out" — both are claims,
  // and the truthful one here is that nothing was measured.
  if (now <= sinceMs) return { maxMs, samples, expected };
  const start = anchor ?? firstInWindow;
  const startSys = anchorSys ?? firstSysInWindow;
  if (start === undefined || now <= start.at) {
    return { maxMs, samples, expected, systemRatio: systemBusyRatio(startSys?.sys, systemCpu()) };
  }
  const live = process.cpuUsage();
  const cpuMs = (live.user + live.system - start.cpuMicros) / 1000;
  return {
    maxMs,
    samples,
    expected,
    cpuRatio: cpuMs / (now - start.at),
    systemRatio: systemBusyRatio(startSys?.sys, systemCpu()),
    // The earliest moment either ratio covers. Compare it to `sinceMs`: the gap is how much of the
    // answer is about the period *before* the question, and it is unbounded — see above.
    ratioFromMs: Math.min(start.at, startSys?.at ?? start.at),
  };
}

/**
 * How often the external witness takes a lag reading, in ms.
 *
 * Deliberately the same cadence as {@link LAG_SAMPLE_INTERVAL_MS} so the two lag figures are the
 * same quantity measured in two processes, and the ratio between them means something.
 */
export const WITNESS_SAMPLE_INTERVAL_MS = 50;

/**
 * How often the witness *emits* what it has sampled, in ms.
 *
 * Not the same as the sample interval, and the difference is load-bearing. The witness writes to a
 * pipe the parent only drains when the parent's loop is running — which is precisely what a stall
 * stops. A full pipe blocks the writer, so a witness that emitted every sample would start
 * reporting *its own* blocked writes as lag and would corroborate whatever the parent said. At one
 * line of ~40 bytes per 250ms that is ~160 B/s against a typical 64 KiB pipe buffer, i.e. over six
 * minutes of stall absorbed before the writer can block. Each line carries its own max, so raising
 * this costs resolution of *when*, never of *how much*.
 */
export const WITNESS_EMIT_INTERVAL_MS = 250;

/**
 * How many times worse the parent's lag must be than the witness's before the disparity is called.
 *
 * A **ratio**, not a millisecond bound, and that is the whole design. Three landings in a row here
 * shipped an absolute threshold that turned out to be a bound inside its own quantity's band; a
 * dimensionless comparison of two processes on the same box at the same moment cancels the machine
 * out. Run 30390018561 measured 23ms (linux, green) against 74823ms (windows, red) for the same
 * quantity under the same demand, so the gap this has to resolve is three orders wide and 10x is
 * nowhere near either edge of it.
 */
export const WITNESS_DISPARITY_RATIO = 10;

/**
 * At or below this ratio the two processes are described as starved together.
 *
 * Deliberately far from {@link WITNESS_DISPARITY_RATIO} so the band between them is a stated
 * "neither" rather than a coin flip on a boundary — the same shape as
 * {@link SYSTEM_SATURATED_RATIO} against {@link SYSTEM_QUIET_RATIO}.
 */
export const WITNESS_SHARED_RATIO = 2;

/**
 * Below this much parent lag there is nothing to attribute, and saying so is the honest answer.
 *
 * Found by running the instrument rather than by reasoning about it. Wired into
 * `browser-playability.test.ts`'s `afterAll`, the first local run printed *"comparable to this
 * process. The box could not schedule the sibling either, so this is machine-wide starvation"* for
 * a parent that had lagged **23ms** — because the ratio branches ask only which process was worse
 * and never whether either was bad. A ratio is scale-free by design, which is exactly why it cannot
 * be allowed to answer on its own: 37ms against 23ms is the same ratio as 74823ms against 46000ms
 * and the opposite finding. A passing log claiming machine-wide starvation is worse than a silent
 * one, because it manufactures a fault to attribute.
 *
 * The floor is stated against the measured gap, not against an imagined machine: healthy readings
 * on this box and on the green `ubuntu-latest` leg are **23-37ms**, and run 30390018561's windows
 * leg is **74823ms**. Three orders separate them and 1000ms sits in neither's neighbourhood — the
 * same argument that justifies {@link WITNESS_DISPARITY_RATIO}, and the same one that retired three
 * absolute deadlines here for sitting inside their own quantity's band.
 */
export const WITNESS_QUIET_LAG_MS = 1_000;

/** One emitted witness bucket: the worst lag inside it, how many readings it covers, and CPU. */
interface WitnessBucket {
  at: number;
  lateBy: number;
  ticks: number;
  cpuMicros: number;
}

const witnessHistory: WitnessBucket[] = [];
let witnessChild: ChildProcess | undefined;
let witnessFailure: string | undefined;

/**
 * The program the witness runs. Inline rather than a file on disk, deliberately.
 *
 * A sibling `.mjs` would have to survive the TypeScript build into `dist/`, be found from both the
 * source and the built tree, and be copied by whatever packages this — three ways for the
 * instrument to be silently absent, and an absent instrument reports exactly what a healthy one
 * does. `-e` has none of those failure modes.
 *
 * It timestamps every reading **itself**. That is the property the whole measurement rests on: the
 * parent may not read this pipe for a minute, but the numbers in it are still about the moments
 * they describe, so the parent's own starvation can delay the witness's testimony and cannot
 * corrupt it.
 */
const WITNESS_PROGRAM =
  `const IV=${WITNESS_SAMPLE_INTERVAL_MS},EM=${WITNESS_EMIT_INTERVAL_MS};` +
  `let due=Date.now()+IV,worst=0,n=0,last=Date.now();` +
  // If the parent dies its end of the pipe closes; exit rather than linger as an orphan.
  `process.stdout.on('error',()=>process.exit(0));` +
  `const t=setInterval(()=>{const now=Date.now();const late=now-due;if(late>worst)worst=late;n++;` +
  `due=now+IV;if(now-last>=EM){const c=process.cpuUsage();` +
  `process.stdout.write('w '+now+' '+worst+' '+n+' '+(c.user+c.system)+'\\n');` +
  `worst=0;n=0;last=now;}},IV);t.unref?.();` +
  // A hard lifetime so a witness can never outlive a run that crashed before it could be stopped.
  `setTimeout(()=>process.exit(0),1800000);`;

/**
 * Start a second Node process whose only job is to report how starved *it* is.
 *
 * **This exists because `cpuRatio: 0%` is consistent with two opposite causes and nothing in this
 * package could tell them apart.** "This process held a CPU 0% of the window" is equally true of a
 * process the OS refused to schedule and of a process sitting inside a blocking syscall — a
 * synchronous read, a lock, a socket wait. Those have opposite fixes: the first is answered by
 * reducing demand on the box, the second by removing the blocking call, and every attempt so far
 * at the first has failed on `windows-latest` while `ubuntu-latest` passes at a similar box load
 * (run 30390018561: 88% busy / 23ms lag against 100% busy / 74823ms lag).
 *
 * A sibling process resolves it, and nothing else in this package can. If the witness keeps time
 * while this process does not, the box **could** schedule work and this process was blocked. If the
 * witness starves too, the machine genuinely could not run anything and the demand is the lever.
 *
 * Cost, measured rather than asserted to be small: the child is a `setInterval` at 50ms that does
 * arithmetic and writes ~160 B/s. It reports its own CPU share so that claim is checkable in every
 * log rather than taken on trust — if the witness is ever seen consuming real CPU, it has become
 * part of the load it exists to measure and this comment is wrong.
 *
 * Idempotent, and silent on failure except that {@link witnessSince} then answers
 * `undefined` — never zero, which would read as "the sibling was never starved" and is the exact
 * empty-instrument-reads-as-a-clean-one shape this file keeps catching.
 *
 * **It cannot keep this process alive.** Both the child process handle and its stdout pipe are
 * `unref`'d; see the comment on those two lines for the measurement that showed one of them is
 * not enough. This matters because `CdpSession.connect()` starts the witness for EVERY consumer
 * of this module — `poc/capture.mjs` and the dev server included — and only one of them has ever
 * called {@link stopExternalLagWitness}.
 */
export function startExternalLagWitness(): void {
  if (witnessChild !== undefined) return;
  try {
    const child = spawn(process.execPath, ['-e', WITNESS_PROGRAM], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    witnessChild = child;
    // BOTH unrefs are load-bearing, and this was found by running it rather than by reading it.
    // `child.unref()` unrefs the *process* handle only; the `'pipe'` stdout is a SEPARATE
    // referenced libuv handle in this process, so with the second line missing the parent cannot
    // exit while the witness lives. Measured: `node poc/capture.mjs` wrote all three PNGs in 15s
    // and was then still alive 2h17m later, because `CdpSession.connect()` starts the witness and
    // only `browser-playability.test.ts`'s afterAll ever stopped it. A diagnostic that changes
    // whether the program terminates is not passive, whatever its CPU cost.
    //
    // Pinned by "does not hold the process open" below, which spawns a child that starts the
    // witness and does nothing else, and requires it to exit on its own.
    child.unref();
    // `child.stdout` is declared `Readable`, but a `'pipe'` stdio is a net.Socket at runtime and
    // that is the type carrying unref(). Narrowed down the hierarchy rather than widened with a
    // structural cast, so the claim being made here is checkable: this is a socket.
    (child.stdout as Socket | null)?.unref();
    child.on('error', (e: Error) => {
      witnessFailure = e.message;
    });
    let carry = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      carry += chunk;
      const lines = carry.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        const parts = line.split(' ');
        if (parts.length !== 5 || parts[0] !== 'w') continue;
        const [at, lateBy, ticks, cpuMicros] = parts.slice(1).map(Number);
        if ([at, lateBy, ticks, cpuMicros].some((n) => !Number.isFinite(n))) continue;
        witnessHistory.push({
          at: at as number,
          lateBy: lateBy as number,
          ticks: ticks as number,
          cpuMicros: cpuMicros as number,
        });
        if (witnessHistory.length > LAG_HISTORY) witnessHistory.shift();
      }
    });
  } catch (e) {
    witnessFailure = e instanceof Error ? e.message : String(e);
  }
}

/** Stop the witness. Safe to call when it was never started. */
export function stopExternalLagWitness(): void {
  witnessChild?.kill();
  witnessChild = undefined;
  witnessHistory.length = 0;
}

/**
 * What the witness observed at or after `sinceMs`, or `undefined` if there is nothing to report.
 *
 * `undefined` covers "never started", "failed to spawn" and "produced nothing yet", and all three
 * are deliberately indistinguishable *to the caller* from each other but sharply distinguishable
 * from a measurement. A zero here would claim the sibling ran perfectly, which is the opposite of
 * what "no data" means.
 *
 * Anchoring mirrors {@link maxLagSince}: buckets whose timestamp falls at or after `sinceMs` are in
 * the window, and the CPU share is taken from the latest bucket at or before it. A bucket
 * straddling `sinceMs` is included whole, so the window can over-report by at most one
 * {@link WITNESS_EMIT_INTERVAL_MS}.
 *
 * `newestAgeMs` exists because the two halves of this result have **different provenance and the
 * difference is invisible without it**. `expected` is derived from the wall window — how many
 * readings the sibling owed between `sinceMs` and now — while `maxMs`, `ticks` and `buckets` come
 * only from reports this process has actually *received* on the child's stdout. A blocked event
 * loop runs no `'data'` handler, so everything the sibling wrote during a stall is still sitting
 * unread in the pipe, and the testimony is truncated **by the very event it is being asked to
 * describe**. The truncation is not neutral: it removes exactly the late readings and biases the
 * answer toward "the sibling kept time", which is the premise of the BLOCKED verdict. So the age of
 * the freshest reading is reported, and {@link describeWitness} refuses to attribute when it does
 * not reach into the period under examination.
 */
export function witnessSince(sinceMs: number):
  | {
      maxMs: number;
      ticks: number;
      expected: number;
      buckets: number;
      newestAgeMs: number;
      cpuRatio?: number;
    }
  | undefined {
  if (witnessHistory.length === 0) return undefined;
  let maxMs = 0;
  let ticks = 0;
  let buckets = 0;
  let anchor: WitnessBucket | undefined;
  let last: WitnessBucket | undefined;
  for (const bucket of witnessHistory) {
    if (bucket.at < sinceMs) {
      anchor = bucket;
      continue;
    }
    buckets += 1;
    ticks += bucket.ticks;
    if (bucket.lateBy > maxMs) maxMs = bucket.lateBy;
    anchor ??= bucket;
    last = bucket;
  }
  if (buckets === 0 || last === undefined) return undefined;
  const now = Date.now();
  const expected = Math.max(0, Math.round((now - sinceMs) / WITNESS_SAMPLE_INTERVAL_MS));
  const newestAgeMs = Math.max(0, now - last.at);
  const spanMs = anchor !== undefined ? last.at - anchor.at : 0;
  const cpuRatio =
    spanMs > 0 && anchor !== undefined
      ? (last.cpuMicros - anchor.cpuMicros) / 1000 / spanMs
      : undefined;
  return { maxMs, ticks, expected, buckets, newestAgeMs, cpuRatio };
}

/**
 * Say whether this process was blocked or the whole machine was, from the two lags together.
 *
 * Neither number alone can answer. `parentMaxMs` on its own is the figure that has been read as
 * "the runner is oversubscribed" for four CI verdicts without anything measuring another process,
 * and the witness on its own says nothing about the process that actually stalled.
 */
export function describeWitness(
  parentMaxMs: number,
  witness: ReturnType<typeof witnessSince>,
): string {
  if (witness === undefined) {
    const why =
      witnessFailure === undefined
        ? ''
        : ` (it failed to start: ${witnessFailure}, which is why there is nothing to compare)`;
    return (
      'No external witness reported over this window, so BLOCKED and NOT SCHEDULED cannot be told ' +
      `apart here${why} — this is an absence of evidence, not evidence the box was healthy`
    );
  }
  const { maxMs, ticks, expected, buckets, newestAgeMs } = witness;
  const cpu =
    witness.cpuRatio === undefined
      ? ''
      : `, itself using ${Math.round(witness.cpuRatio * 100)}% CPU`;
  const band = `a sibling Node process on the same box lagged ${maxMs}ms over ${ticks} of ~${expected} reading(s) in ${buckets} report(s)${cpu}`;
  // Asked BEFORE the ratio, because a ratio is scale-free and therefore cannot tell a healthy box
  // from a starved one. Both processes keeping near-perfect time is the shared branch's arithmetic
  // and the opposite of its conclusion.
  if (parentMaxMs < WITNESS_QUIET_LAG_MS) {
    return (
      `${band} — and this process lagged only ${parentMaxMs}ms, under the ${WITNESS_QUIET_LAG_MS}ms ` +
      `floor, so NEITHER process was starved over this window and there is nothing to attribute`
    );
  }
  // Asked before any comparison, because a comparison over testimony that stops short of the stall
  // is not a weak measurement, it is a measurement of a different window. See {@link witnessSince}:
  // reports arrive on the child's stdout, a blocked loop reads no stdout, so the readings covering
  // the stall are still unread at the moment a verdict computed inside the timers phase is built.
  // The truncation removes precisely the late readings, which is what makes the sibling look
  // punctual and this process look BLOCKED — the instrument censored by its own subject.
  //
  // The predicate compares two MEASURED quantities rather than testing an invented constant: if the
  // freshest reading is older than the stall it is meant to describe, it cannot describe it. This
  // repository has retired four absolute thresholds for sitting inside their own band, and a
  // coverage threshold in milliseconds would have been the fifth.
  if (newestAgeMs >= parentMaxMs) {
    return (
      `${band} — but its freshest reading is ${newestAgeMs}ms old while this process lagged ` +
      `${parentMaxMs}ms, so the testimony STOPS SHORT OF THE STALL it would have to describe and ` +
      `NO ATTRIBUTION IS POSSIBLE from this window. A blocked event loop reads no stdout, so ` +
      `whatever the sibling wrote during the stall is still unread here; the gap is the instrument ` +
      `being censored by the very event it measures, not evidence the sibling kept time`
    );
  }
  const ratio = parentMaxMs / Math.max(maxMs, 1);
  if (maxMs < WITNESS_QUIET_LAG_MS) {
    if (ratio >= WITNESS_DISPARITY_RATIO) {
      return (
        `${band} — ${Math.round(ratio)}x less than this process, and under the ` +
        `${WITNESS_QUIET_LAG_MS}ms floor in absolute terms. THE BOX COULD SCHEDULE WORK, so this ` +
        `process was BLOCKED rather than starved of CPU: look for a synchronous call, a lock or an ` +
        `I/O wait on this side, not for a neighbour to blame`
      );
    }
    return (
      `${band} — under the ${WITNESS_QUIET_LAG_MS}ms floor, but only ${Math.round(ratio)}x less ` +
      `than this process, so neither BLOCKED nor machine-wide starvation is established here`
    );
  }
  if (ratio <= WITNESS_SHARED_RATIO) {
    return (
      `${band} — comparable to this process. The box could not schedule the sibling either, so ` +
      `this is machine-wide starvation and the lever is the demand on the box`
    );
  }
  // The sibling is over the floor on its own absolute figure, which is machine-wide starvation
  // whatever the ratio says. The disparity is deliberately NOT reported as BLOCKED on top: two
  // lags, both real, cannot separate "this process was ALSO blocked" from "this process was
  // starved worse" — and the previous code said BLOCKED here, over a sibling that had itself
  // lagged 13806ms, which is a sentence that contradicts its own evidence.
  return (
    `${band} — itself over the ${WITNESS_QUIET_LAG_MS}ms floor, so the box could not schedule a ` +
    `process whose only job is to keep time: MACHINE-WIDE STARVATION IS ESTABLISHED on that ` +
    `absolute figure alone. This process lagged ${Math.round(ratio)}x more, and that disparity ` +
    `does NOT add BLOCKED on top of it: two starved processes cannot say which of them was also ` +
    `blocked`
  );
}

/**
 * Whether a deadline fired when it was asked to, or long after — or fired on time over a loop that
 * had nevertheless stopped.
 *
 * `stalled` exists because the first two were not enough, and the gap was not theoretical: run
 * 30371952350 printed *"fired 152ms late, i.e. on time, so this process was being scheduled
 * throughout"* in the same sentence as *"event-loop lag 30102ms over 2 sample(s)"*. Both cannot be
 * true. **A long deadline absorbs a block that a short sampler exposes**: a 30s timer created at T
 * and a 50ms sampler both come due when a 30s block ends, and the timer is 152ms overdue while the
 * sampler is 30s overdue. The overshoot is therefore a *weak* detector of starvation — it can only
 * see a block that outlasts the deadline itself — and reading it as the strong one inverted the
 * attribution on two of that run's three failures.
 */
export type DeadlineVerdict = 'on-time' | 'late' | 'stalled';

/**
 * The lag beyond which this process cannot be described as having run continuously.
 *
 * Same scale and same reasoning as {@link LATE_OVERSHOOT_MS}: twenty sampler intervals, well clear
 * of ordinary GC and scheduler jitter, and three orders below the figures that motivated it.
 */
export const STALL_LAG_MS = 1_000;

/**
 * The busy share at or above which the whole box is described as saturated.
 *
 * Not a tuned number: at 85% of every core there is under a core and a half free on a 16-way box
 * and under two thirds of one on a 4-vCPU runner, which is the shape that starves a process to 0%.
 */
export const SYSTEM_SATURATED_RATIO = 0.85;

/**
 * The busy share at or below which CPU contention is **refuted** as the reason this process stalled.
 *
 * Deliberately far from {@link SYSTEM_SATURATED_RATIO} rather than adjacent to it, so the band
 * between them is a stated "neither" rather than a coin flip on the boundary. A box half idle did
 * not deny anyone a core.
 */
export const SYSTEM_QUIET_RATIO = 0.5;

/**
 * Name what the CPU shares say, or say that they say nothing.
 *
 * **The `NOT SCHEDULED` branch used to end `so the box is oversubscribed by something outside this
 * process`, and nothing in this file measured the box.** `cpuRatio` is `process.cpuUsage()` over
 * wall time: it is a statement about *this* process and is silent about every other. The clause
 * after "so" was an inference, printed in the same typeface as the measurement beside it, and it
 * was carried into the record of three landings and one CI verdict (`windows-latest` runs
 * 30377421271 and 30380984122, where every failure read `0%` and was written up as an oversubscribed
 * runner). That is this repository's central defect class — an instrument that cannot distinguish
 * two causes attributing to whichever it can name — occurring inside the diagnostic added to stop it.
 *
 * The fork matters because the two branches have different next steps. Node at 0% with the box
 * **idle** means CPU contention was never the mechanism, every conclusion drawn from these runs
 * needs revisiting, and the next instrument is elsewhere entirely — I/O, a lock, a synchronous
 * filesystem call, Defender, or the socket. Only a measurement of the box can tell those apart, so
 * this now takes one.
 *
 * **The saturated branch is weaker than it first looks, and this is measured rather than hedged.**
 * A saturated box neither identifies who saturated it — `os.cpus()` counts the browser and dev
 * server this suite starts — nor establishes that saturation is what stalled the loop. Run
 * 30390018561 measured both legs on one tree: `ubuntu-latest` **88% busy, 23ms worst lag over 739
 * of ~745 samples, green**, and `windows-latest` **100% busy, 74823ms over 1284 of ~16830, red**.
 * The same demand at a similar load starves one OS 3250x harder than the other, so "the box is
 * busy" cannot be the mechanism on its own. This branch therefore reports and refuses to conclude.
 */
function describeCpu(lag: { cpuRatio?: number; systemRatio?: number }): string {
  const { cpuRatio, systemRatio } = lag;
  if (cpuRatio === undefined) return 'CPU share unknown — not measured over this window';
  const pct = Math.round(cpuRatio * 100);
  if (cpuRatio >= 0.8) return `this process held a CPU ${pct}% of the window — it was RUNNING`;
  if (cpuRatio > 0.2) {
    const box = systemRatio === undefined ? '' : `, box ${Math.round(systemRatio * 100)}% busy`;
    return `this process held a CPU ${pct}% of the window${box} — partly scheduled`;
  }
  if (systemRatio === undefined) {
    return (
      `this process held a CPU only ${pct}% of the window — it was NOT SCHEDULED. Whether the box ` +
      `was oversubscribed is UNMEASURED over this window, so do not assume it`
    );
  }
  const box = Math.round(systemRatio * 100);
  if (systemRatio >= SYSTEM_SATURATED_RATIO) {
    return (
      `this process held a CPU only ${pct}% of the window while every core together was ${box}% ` +
      `busy — it was NOT SCHEDULED on a saturated box. WHO saturated it is not established by this ` +
      `field: os.cpus() counts every process on the machine, and the browser and dev server this ` +
      `suite starts are among them — measure a window before anything of ours exists to tell a ` +
      `neighbour from our own demand. Nor does saturation on its own explain the stall: run ` +
      `30390018561 measured ubuntu-latest at 88% busy with a 23ms worst lag and windows-latest at ` +
      `100% busy with 74823ms, on the same tree under the same demand`
    );
  }
  if (systemRatio <= SYSTEM_QUIET_RATIO) {
    return (
      `this process held a CPU only ${pct}% of the window, but every core together was only ` +
      `${box}% busy — so nothing was competing for the CPU it did not get. OVERSUBSCRIPTION IS ` +
      `REFUTED for this window: look for a block that is not CPU at all (I/O, a lock, a ` +
      `synchronous filesystem call, or the socket itself)`
    );
  }
  return (
    `this process held a CPU only ${pct}% of the window and every core together was ${box}% busy ` +
    `— NOT SCHEDULED, but the box was not saturated either, so neither branch is established`
  );
}

/**
 * Say which side of the socket a transport timeout points at, from the deadline's own overshoot
 * **and** from the loop's own lag, which are not the same evidence.
 *
 * This exists because the transport timeout message asserted something its own numbers refuted.
 * It opened *"The browser accepted the command and did not answer"* — a claim about the browser —
 * while reporting an elapsed time of **53484ms against a 30000ms deadline** (`windows-latest`, run
 * 30364502178). A timer that fires 23 seconds late did not measure a silent browser: it measured a
 * Node process that was not scheduled, or was inside something synchronous, for 23 seconds. A reply
 * may well have arrived on the socket and sat unread. Two more failures in the same run overshot by
 * 17.0s and 5.8s.
 *
 * The overshoot was in the message all along and nobody read it, which is why the classification is
 * a function rather than a sentence: a shape that is computed gets looked at, and a shape that is
 * merely printed does not. The same run's three failures were read as browser-side wedges purely
 * because the taxonomy the message offered — cliff, climb, empty — describes only the far side.
 *
 * **And then this function made the same mistake one level in.** It classified from the overshoot
 * alone and printed *"so this process was being scheduled throughout"* — a claim the lag figure
 * beside it flatly refuted, twice in one run. See {@link DeadlineVerdict}. The repair is not a
 * better sentence: it is to let the quantity that can see the fault decide, and to make the case
 * where the two disagree a **named verdict** rather than a footnote to a wrong one.
 */
export function describeDeadline(
  elapsedMs: number,
  timeoutMs: number,
  lag: {
    maxMs: number;
    samples: number;
    expected?: number;
    cpuRatio?: number;
    systemRatio?: number;
  },
): { verdict: DeadlineVerdict; text: string } {
  const overshoot = elapsedMs - timeoutMs;
  const coverage = lag.expected === undefined ? '' : ` of ~${lag.expected} due`;
  const band = `${lag.maxMs}ms over ${lag.samples} sample(s)${coverage}`;
  if (overshoot > LATE_OVERSHOOT_MS) {
    return {
      verdict: 'late',
      text:
        `The ${timeoutMs}ms deadline fired ${overshoot}ms LATE, and this process's own event loop ` +
        `lagged up to ${band} while the command was outstanding. A deadline that late was not ` +
        `measuring a silent browser: it was measuring a Node process that was not running. The ` +
        `reply may have arrived and gone unread, so look at THIS side of the socket first — the ` +
        `transport band below describes the far side and cannot see this. ${describeCpu(lag)}.`,
    };
  }
  if (lag.maxMs > STALL_LAG_MS) {
    return {
      verdict: 'stalled',
      text:
        `The ${timeoutMs}ms deadline fired only ${overshoot}ms late, but that does NOT mean this ` +
        `process ran throughout: its event loop lagged up to ${band} while the command was ` +
        `outstanding. A deadline this long absorbs a block shorter than itself — the timer and the ` +
        `50ms sampler both come due when the block ends, and only the sampler shows how long it ` +
        `was. So the loop stopped and the reply could have arrived and gone unread. ` +
        `${describeCpu(lag)}. Look at THIS side of the socket first.`,
    };
  }
  return {
    verdict: 'on-time',
    text:
      `The ${timeoutMs}ms deadline fired ${overshoot}ms late, and the loop kept up throughout ` +
      `(worst event-loop lag while the command was outstanding: ${band}), so the reply genuinely ` +
      `did not arrive. ${describeCpu(lag)}. Look at the browser.`,
  };
}

export class CdpSession {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { ok: (value: unknown) => void; fail: (e: Error) => void }>();
  readonly #diagnostics: string[] = [];
  readonly #warnings: string[] = [];
  /**
   * Elapsed ms of recent *successful* round trips on this session, in arrival order.
   *
   * This exists because the transport timeout message was honest about a gap it could not close: it
   * said, correctly, that it could not tell a dead transport from a browser too starved to answer.
   * Saying so is better than over-claiming, but the right response to "my instrument cannot
   * distinguish these" is to measure the quantity that does. A 30s timeout preceded by twenty 20ms
   * round trips is a session that fell off a cliff; the same timeout preceded by round trips
   * climbing 200ms, 900ms, 4000ms is a session being progressively starved; and a timeout with *no*
   * prior successes at all is a session that never worked, which is a third thing again and the one
   * a latency band would otherwise hide by being empty.
   */
  readonly #roundTrips: number[] = [];
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      // CDP multiplexes command replies (which carry `id`) and events (which carry `method`) down
      // one socket. Events used to be dropped here, which meant a page that threw on load was
      // indistinguishable from a page that loaded fine and simply never satisfied the condition
      // being waited on — the timeout said only what was awaited, never why it never arrived.
      if (message.method !== undefined) {
        this.#record(message.method, message.params);
        return;
      }
      if (message.id === undefined) return;
      const waiter = this.#pending.get(message.id);
      if (waiter === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) waiter.fail(new Error(message.error.message));
      else waiter.ok(message.result);
    });
  }

  /** Connect to a CDP WebSocket endpoint. */
  static connect(url: string): Promise<CdpSession> {
    // Started here rather than at module load so that importing this file costs nothing: the lag
    // figure is only ever read by a transport timeout, and a process with no CDP session cannot
    // have one. Idempotent, so every subsequent session shares the one sampler.
    startEventLoopLagMonitor();
    // Same reasoning, and the same place, for the sibling process: it answers the question the lag
    // figure alone cannot -- whether the box could schedule anything at all while this process
    // could not. Starting it anywhere earlier would spawn a Node process for every importer.
    startExternalLagWitness();
    return new Promise((ok, fail) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => ok(new CdpSession(socket)));
      socket.addEventListener('error', () => fail(new Error(`cannot connect to ${url}`)));
    });
  }

  /** Page-side failures, in arrival order. The only place a browser-side error is reported. */
  get diagnostics(): readonly string[] {
    return this.#diagnostics;
  }

  /**
   * Page-side *warnings*, in arrival order. Kept separate and surfaced only when a timeout has no
   * errors to report, because the failure that motivated this is a warning: Chrome emits
   * "Automatic fallback to software WebGL has been deprecated" at `warning` level and then hands
   * back a null context, so a page can fail to start with nothing at `error` level at all.
   */
  get warnings(): readonly string[] {
    return this.#warnings;
  }

  /**
   * The recent successful round trips on this session, oldest first, in ms.
   *
   * Exposed so a caller can report the band without waiting for a failure — a green run that prints
   * its latency is the only thing that makes a later red readable, because a band is meaningless
   * until you know what normal looked like on the same machine.
   */
  get roundTrips(): readonly number[] {
    return this.#roundTrips;
  }

  /**
   * One line describing this session's recent transport health, or an explicit statement that it
   * has never completed a command.
   *
   * The empty case is spelled out rather than rendered as an empty band, because "no data" reading
   * as "nothing wrong" is this project's most-repeated defect and a band printed as `[]` is exactly
   * that shape.
   */
  describeTransport(): string {
    const trips = this.#roundTrips;
    if (trips.length === 0) {
      return (
        'this session has never completed a single command, so there is no healthy band to ' +
        'compare against: it did not degrade, it never worked'
      );
    }
    const sorted = [...trips].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
    return (
      `last ${trips.length} successful round trip(s) on this session: ` +
      `min ${sorted[0]}ms, median ${median}ms, max ${sorted[sorted.length - 1]}ms; ` +
      `most recent first-to-last ${trips.join('/')}ms`
    );
  }

  #record(method: string, params: Record<string, unknown> | undefined): void {
    const event = classifyEvent(method, params);
    if (event === undefined) return;
    // Bounded: a page in a render loop can throw once per frame, and a thousand copies of one
    // message is not more informative than the first few.
    const into = event.level === 'error' ? this.#diagnostics : this.#warnings;
    if (into.length < 20) into.push(event.text);
  }

  /**
   * Send a CDP command and await its result, with a deadline on the *transport itself*.
   *
   * The deadline is not defensive tidiness; it is the difference between an instrument that can
   * report and one that cannot. `until()` bounds how long a *condition* may take, and it checks
   * its deadline between polls — so it can only ever check it if each poll returns. A command that
   * is accepted and never answered leaves `await evaluate(...)` pending forever, `until` never
   * reaches its own deadline line, and the whole thing dies at vitest's per-test timeout with no
   * message at all.
   *
   * That is exactly what run 30340124068 produced on `windows-latest`: eight cases, every one of
   * them `Test timed out in 90000ms`, and **not one line of diagnostic output** — no boot time, no
   * page description, though the machinery to print both had been landed in the two preceding
   * commits specifically so that a timeout would explain itself. The blank-page control in the
   * same file passed at 3861 fps, so the browser was alive and answering. Whatever stops answering
   * does so once an application page is involved, and the previous design guaranteed it would stay
   * anonymous.
   *
   * 30s: every command this file sends is either a protocol round trip or a `Runtime.evaluate` of
   * a small expression. Measured on this box, a launch-plus-`openPage` round trip costs 0.7-4.8s
   * (four samples alone, four under full-suite parallelism), so 30s is roughly 6x the worst routine
   * observation. It is a hang detector, not a performance bound.
   *
   * It is NOT, however, able on its own to tell a dead transport from a browser too starved to
   * answer, and an earlier version of the message asserted that it was. That claim was measured
   * false during this change set's own gate: on a box whose 16 logical CPUs were pinned at 100% by
   * an unrelated runaway process, a `Page.navigate` exceeded 30s and was reported as a hang. The
   * number stays where it is, because it has to remain smaller than the budgets containing it for
   * the failure to be *named* at all, and a named failure beats a mute one.
   *
   * What the message no longer does is stop at admitting the gap. Saying "my instrument cannot
   * distinguish these two" is honest, and the correct next move is to measure the quantity that
   * can: the session now carries the elapsed time of its recent successful round trips and prints
   * that band alongside the failure. Three shapes fall out of it, and they have different fixes —
   * a healthy band that stops dead is a wedge, a climbing band is starvation, and an *empty* band
   * means the session never completed a command in its life. Run 30347429388 produced two failures
   * on `Page.enable (id 1)` — the first command of a fresh session — which is that third shape and
   * is not a thing a larger deadline can repair.
   *
   * All three of those shapes describe the *far* side of the socket, and there is a fourth that
   * they cannot see and that this message spent three landings mis-attributing: the deadline's own
   * lateness. See {@link describeDeadline} — a 30000ms deadline reported at 53484ms did not observe
   * a silent browser, it observed a Node process that was not running for 23 seconds, and the reply
   * may have been sitting unread on the socket the whole time. That figure was printed in every one
   * of those failures and read by nobody, because nothing computed anything from it.
   */
  send<T = Record<string, unknown>>(
    method: string,
    params: object = {},
    timeoutMs = TRANSPORT_TIMEOUT_MS,
  ): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((ok, fail) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        // Synchronous, and deliberately so: removing the pending entry here is what decides the
        // COMMAND'S outcome, and it must not move. A reply arriving in this iteration's poll phase
        // then finds no entry and is discarded as unmatched, exactly as before this deferral.
        this.#pending.delete(id);
        const firedAt = Date.now();
        // Everything below is DIAGNOSIS, and it is deferred by one libuv iteration for a measured
        // reason. libuv runs the timers phase BEFORE the poll phase, so at this instant every byte
        // the external witness wrote while this process was blocked is still unread in its pipe —
        // see {@link witnessSince}. A verdict computed here is computed over testimony truncated by
        // the very stall it is describing. Both regimes of that truncation were measured on this
        // box, with the deferral removed and restored, over a 4000ms block against a 1500ms
        // deadline:
        //   - window opened before the stall: the history survives but stops short of it, biasing
        //     toward "the sibling kept time", which is the premise of the BLOCKED verdict (the
        //     drain case measures 1623ms of testimony sitting unread);
        //   - window opened at the stall, as here: NOT ONE report is read, `witnessSince` returns
        //     undefined, and the message degrades to "No external witness reported over this
        //     window" — no attribution at all, from a sibling that reported 15 times.
        // `setImmediate` runs in the CHECK phase, after this iteration's poll phase has drained the
        // pipe, so the comparison is made over complete evidence. Not unref'd: an unref'd immediate
        // could be reaped before it runs and leave this promise permanently unsettled.
        setImmediate(() => {
          const lag = maxLagSince(startedAt);
          const deadline = describeDeadline(firedAt - startedAt, timeoutMs, lag);
          const witness = describeWitness(lag.maxMs, witnessSince(startedAt));
          fail(
            new Error(
              `[cdp] no reply to ${method} (id ${id}) after ${firedAt - startedAt}ms, so every ` +
                `deadline waiting on this reply was unreachable and would have expired mutely. ` +
                `${deadline.text} ${witness}. Transport health: ${this.describeTransport()}. Read ` +
                `the three shapes apart rather than pooling them: a cliff (healthy band, then ` +
                `nothing) is a wedge; a climb is starvation; and no completed commands at all ` +
                `means the session never worked, which no amount of extra deadline will fix.`,
            ),
          );
        });
      }, timeoutMs);
      // Unref so a pending command can never by itself hold the process open; the rejection above
      // is what callers see, and a stray timer outliving the run would be its own defect.
      timer.unref?.();
      this.#pending.set(id, {
        ok: (value) => {
          clearTimeout(timer);
          this.#roundTrips.push(Date.now() - startedAt);
          if (this.#roundTrips.length > ROUND_TRIP_HISTORY) this.#roundTrips.shift();
          (ok as (value: unknown) => void)(value);
        },
        fail: (e) => {
          clearTimeout(timer);
          fail(e);
        },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Close the socket. */
  close(): void {
    this.#socket.close();
  }
}

/**
 * Render the CDP events that mean "the page is broken or complaining", and ignore the rest.
 *
 * Deliberately narrow at `error` level: the point is to explain a timeout, and a transcript of
 * every network and lifecycle event would bury the one line that matters. Warnings are classified
 * too but kept in their own bucket, because they are usually noise — except when there is nothing
 * else, which is the case this exists for.
 */
export function classifyEvent(
  method: string,
  params: Record<string, unknown> | undefined,
): { level: 'error' | 'warning'; text: string } | undefined {
  if (params === undefined)
    return method === 'Inspector.targetCrashed'
      ? { level: 'error', text: 'the page crashed' }
      : undefined;
  if (method === 'Runtime.exceptionThrown') {
    const details = params['exceptionDetails'] as
      { text?: string; exception?: { description?: string } } | undefined;
    const described = details?.exception?.description ?? details?.text;
    return described === undefined
      ? undefined
      : { level: 'error', text: `uncaught in page: ${described}` };
  }
  if (method === 'Log.entryAdded') {
    const entry = params['entry'] as { level?: string; text?: string } | undefined;
    if (entry?.text === undefined) return undefined;
    if (entry.level === 'error') return { level: 'error', text: `browser log: ${entry.text}` };
    if (entry.level === 'warning')
      return { level: 'warning', text: `browser warning: ${entry.text}` };
    return undefined;
  }
  if (method === 'Inspector.targetCrashed') return { level: 'error', text: 'the page crashed' };
  return undefined;
}

/**
 * Ask the page to describe itself, for use when a wait has timed out.
 *
 * A timeout with no page-side error is the least informative failure this harness can produce, and
 * it is the one `windows-latest` produces: run 30328777305 failed eight cases with
 * "the page reported no error" at a 60s deadline, three times the boot time the same tests measure
 * on this machine, which refutes slow-boot as the cause. Every remaining explanation -- the page
 * never navigated, its modules never arrived, WebGL is unavailable so the renderer never
 * constructed, the app booted but never reached the awaited state -- is a *different fact about
 * the page*, and none of them can be distinguished from a message that only says what was awaited.
 *
 * So this reports the facts rather than guessing between them. It is deliberately one round trip
 * that answers all of the above at once, because the machine that exhibits the fault is a CI
 * runner with a ~25 minute turnaround and iterating one hypothesis per run is not affordable.
 */
export async function describePage(cdp: CdpSession): Promise<string> {
  const probe = `(() => {
    const out = {};
    const attempt = (name, f) => { try { out[name] = f(); } catch (e) { out[name] = 'threw: ' + e; } };
    attempt('href', () => String(location.href));
    attempt('readyState', () => document.readyState);
    attempt('title', () => document.title);
    attempt('bodyChars', () => (document.body ? document.body.innerHTML.length : -1));
    attempt('canvases', () => document.querySelectorAll('canvas').length);
    attempt('aegis', () => typeof globalThis.aegis);
    attempt('scripts', () =>
      Array.from(document.querySelectorAll('script')).map((s) => (s.src || 'inline') + ' [' + (s.type || 'classic') + ']'));
    attempt('webgl2', () => !!document.createElement('canvas').getContext('webgl2'));
    attempt('webgl', () => !!document.createElement('canvas').getContext('webgl'));
    attempt('resources', () =>
      performance.getEntriesByType('resource').map((r) => {
        const leaf = String(r.name).split('/').pop();
        return leaf + ' ' + Math.round(r.duration) + 'ms' + (r.transferSize === 0 ? ' transfer=0' : '');
      }));
    return JSON.stringify(out);
  })()`;
  try {
    const raw = await evaluate<string>(cdp, probe);
    const state = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(state)
      .map(
        ([key, value]) =>
          `    ${key}: ${Array.isArray(value) ? JSON.stringify(value) : String(value)}`,
      )
      .join('\n');
  } catch (error) {
    // The probe failing is itself a finding, and a far stronger one than a timeout: it means the
    // page could not run a trivial expression. Reported rather than swallowed, because an empty
    // diagnostic that reads as "nothing to say" is the exact defect this function exists to close.
    return `    (the page could not describe itself: ${String(error)})`;
  }
}

/** Virtual key codes for every key the binding tables can name. */
const VIRTUAL_KEYS: Readonly<Record<string, { key: string; vk: number }>> = {
  KeyA: { key: 'a', vk: 65 },
  KeyD: { key: 'd', vk: 68 },
  KeyS: { key: 's', vk: 83 },
  KeyW: { key: 'w', vk: 87 },
  Space: { key: ' ', vk: 32 },
  ArrowUp: { key: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', vk: 39 },
};

/** Dispatch a real key event into the page. */
export async function key(cdp: CdpSession, code: string, down: boolean): Promise<void> {
  const spec = VIRTUAL_KEYS[code];
  if (spec === undefined) {
    throw new Error(
      `[aegis:render-three] no virtual-key mapping for "${code}". Add it to VIRTUAL_KEYS ` +
        'so the capture can press the key a human would.',
    );
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: down ? 'keyDown' : 'keyUp',
    code,
    key: spec.key,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
    text: down && spec.key.length === 1 ? spec.key : undefined,
  });
}

/** Dispatch a primary mouse button edge at canvas pixel `(x, y)`. */
export async function mouseButton(
  cdp: CdpSession,
  down: boolean,
  x: number,
  y: number,
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', {
    type: down ? 'mousePressed' : 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
    buttons: down ? 1 : 0,
  });
}

/** A full click at canvas pixel `(x, y)`. */
export async function click(cdp: CdpSession, x: number, y: number): Promise<void> {
  await mouseButton(cdp, true, x, y);
  await sleep(20);
  await mouseButton(cdp, false, x, y);
}

/** Move the mouse to an absolute canvas position (the page reads the resulting delta). */
export async function mouseMove(cdp: CdpSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
}

/** Evaluate an expression in the page and return its JSON value. */
export async function evaluate<T>(cdp: CdpSession, expression: string): Promise<T> {
  const result = await cdp.send<{
    result: { value: T };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`[aegis:render-three] page threw evaluating \`${expression}\`: ${detail}`);
  }
  return result.result.value;
}

/**
 * Default deadline for {@link until}, in milliseconds.
 *
 * Exported rather than left as a literal so that callers which have to *contain* it can compute
 * with it. A test budget smaller than the deadlines inside it cannot let any of them fire, and a
 * number copied into a comment in another file is exactly the shared-mutable-index defect this
 * repository has been bitten by before. `browser-playability.test.ts` derives its per-case budgets
 * from this constant and asserts the containment, so raising this reddens that guard rather than
 * silently making eight cases mute again.
 */
export const DEFAULT_UNTIL_TIMEOUT_MS = 60_000;

/**
 * Deadline for the post-`Page.navigate` commit wait inside {@link openPage}, in milliseconds.
 *
 * Exported for the same reason as {@link DEFAULT_UNTIL_TIMEOUT_MS}: every caller of `openPage`
 * pays this before any of its own deadlines start, so a budget that does not include it is wrong.
 */
export const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Deadline for the post-`Page.bringToFront` focus wait inside {@link openPage}, in milliseconds.
 *
 * Exported for the same reason as {@link NAVIGATION_TIMEOUT_MS}: it sits on the `openPage` path, so
 * every caller pays it before any of its own deadlines start and a budget that omits it is wrong.
 * Left at the {@link DEFAULT_UNTIL_TIMEOUT_MS} default it would have added an unnamed 60s to three
 * budgets that had just been derived to the tenth of a second — the merge that introduced this wait
 * and the change that established the containment discipline were textually independent and
 * semantically not.
 *
 * 10s, derived the same way the others are. Measured on this box with four browsers coming up
 * concurrently, 16 samples polled every 25ms: 15 already focused when `bringToFront` resolved, one
 * arriving 213ms later, none outstanding at 3s. Windows CI has been measured at 5.6x this box, so
 * the scaled worst observation is ~1.2s and 10s is roughly 8x that. It is a bound on hanging, not a
 * budget: focus either propagates in a few hundred milliseconds or something is wrong that waiting
 * will not fix.
 */
export const FOCUS_TIMEOUT_MS = 10_000;

/**
 * Deadline for a freshly spawned browser to expose its DevTools endpoint, in milliseconds.
 *
 * This value is unchanged, but it was a bare literal inside `launchBrowser` and therefore invisible
 * to the containment arithmetic — which is how it came to be the largest deadline on a path whose
 * budget did not count it. Measured on this Windows box: launch costs 1188/1556/1359/1656ms alone
 * and 1637/1982/2658/1983ms under full-suite parallelism, so 30s is roughly 11x the worst routine
 * observation. It has nevertheless been *seen* to expire, once, on a box under external starvation
 * (16 logical CPUs pinned at 100% by a runaway `msedgewebview2` holding ~400 000 CPU-seconds). That
 * excursion is recorded rather than used to size this number: a bound taken from a pathological
 * outlier is as unjustified as one taken from a single quiet reading, and the failure it produces
 * is at least *named* (`browser did not expose a DevTools endpoint`) rather than mute, which is the
 * property this change set exists to establish.
 *
 * What was actually wrong was the containment, not the value: two cases in
 * `browser-diagnostics.test.ts` had a 60s budget containing 30 (this) + 30 (navigate reply) +
 * 30 (navigation commit) + 2 = 92s of deadlines, so under load they died at the budget having said
 * nothing. Exported so both browser test files can compute with it and assert that they contain it.
 */
export const LAUNCH_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a freshly launched browser to become capable of painting, in milliseconds.
 *
 * ## This exists because the flags were never the cause, and three probes were needed to see it
 *
 * `windows-latest` was believed to need launch flags to paint at all. Landing #17 measured a blank
 * page going from 0fps to 3861fps when seven flags were added at once and credited four of them;
 * landing #20 removed the other three on that credit. Both readings were confounded, and the
 * confounder was **measurement order**.
 *
 * The control that settled it held the flags fixed and varied only position (CI run 30362144330,
 * `windows-latest`, occlusion flags only in both blocks):
 *
 *     O.2   0 frames @44.9s        FV.1  0   @60.0s        O.6   192 @82.5s
 *     O.3   0 frames @48.7s        FV.2  117 @63.7s        O.7   193 @86.7s
 *     O.4   0 frames @52.4s        FV.3  143 @68.4s        O.8   186
 *     O.5   0 frames @56.2s        FV.4  167 @73.9s        O.9   187
 *
 * The trailing block has the **same flags** as the leading one and reads 189 where it read 0.
 * Meanwhile the page's timer fired ~187 times and the 3s window took 3000ms of wall clock in every
 * cell: the page runs perfectly and is simply not drawn. `ubuntu-latest` painted from its first
 * launch at 10.7s in the same run and has never had a cold period.
 *
 * A follow-up (run 30362542986) asked the only question that determines the fix -- does a page that
 * is not painting start painting if you *wait*:
 *
 *     poll @7.7s    3 frames in a 2s window     <- not painting
 *     poll @9.7s   82 frames in a 2s window     <- painting
 *     a fresh browser @13.7s: 187 frames/3s; another @18.0s: 194 frames/3s
 *
 * Yes, and once the runner is warm every subsequent browser paints from launch.
 *
 * **What governs the cold period is NOT established.** Across four probe runs `windows-latest`
 * warmed at ~10s twice and ~40-60s twice. Whether that is elapsed time, cumulative browser work, or
 * a consequence of a failed first launch is unknown and is recorded as unknown. This deadline does
 * not depend on knowing: it measures the condition directly and waits for it, which is the same
 * move that replaced guessing at navigation with asserting arrival.
 *
 * 90s is ~1.4x the longest cold period observed (63s) and sits inside the hook budget that contains
 * it. It costs nothing on a warm runner or on Linux -- {@link waitForPaint} returns on its first
 * poll -- and is only ever spent when the alternative is nine cases failing mute.
 */
export const PAINT_TIMEOUT_MS = 90_000;

/** Frames a one-second window must show before the browser counts as painting. */
export const PAINT_FRAMES_FLOOR = 10;

/**
 * What a pair of counters says about a page: being drawn, running but not drawn, or not running.
 *
 * Separated from the waiting loop and exported so it can be driven over every shape directly. No
 * browser produces "alive but never composited" on demand, and a decision path that can only be
 * exercised by getting lucky with a CI runner is one nobody can trust -- the same reason
 * {@link classifyEvent} was extracted in landing #15.
 *
 * The distinction the two counters buy is the whole diagnosis, and it is why frames alone will not
 * do. Zero frames with a healthy timer is a page that is alive and not composited, which waiting
 * fixes. Zero frames with a dead timer is a page that is not executing, which waiting does not fix
 * and which must not be reported as though it were the same thing.
 */
export type PaintVerdict = 'painting' | 'warming' | 'not-executing';

export function paintVerdict(frames: number, timerTicks: number): PaintVerdict {
  if (frames >= PAINT_FRAMES_FLOOR) return 'painting';
  if (timerTicks > 0) return 'warming';
  return 'not-executing';
}

/**
 * Wait until `cdp`'s page actually paints, and return how long that took.
 *
 * Installs two independent clocks -- `requestAnimationFrame`, which stops when compositing stops,
 * and `setTimeout`, which does not -- and polls both. Throws a message naming both counters and the
 * verdict, so a failure says which of the two failure modes happened rather than only that a
 * condition was not met.
 *
 * Deliberately NOT inside `launchBrowser` or `openPage`. `poc/capture.mjs` and the diagnostics
 * suite launch browsers whose cases do not depend on compositing at all, and making every caller
 * pay a paint wait for one caller's precondition is the mistake landing #18 avoided when it put the
 * focus wait in the test rather than in `openPage`.
 */
export async function waitForPaint(
  cdp: CdpSession,
  timeoutMs = PAINT_TIMEOUT_MS,
): Promise<{ ms: number; frames: number; timerTicks: number; polls: number }> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // Idempotent by construction, and that is not tidiness. The first version declared its callbacks
  // with `const` at the top level of the evaluate, so a *second* call against the same page died
  // with `SyntaxError: Identifier 'paintStep' has already been declared` -- a message about nothing
  // that matters, in place of the measurement. Found by the control below on its second assertion.
  // Any caller that retries, or that waits once for a blank page and again after navigating, would
  // have hit it. The counters are reset on every call; the two chains are installed once, because a
  // second chain would double the frame count and quietly halve the threshold.
  await evaluate<null>(
    cdp,
    `(() => {
       globalThis.__paintFrames = 0;
       globalThis.__paintTicks = 0;
       if (globalThis.__paintInstalled === true) return null;
       globalThis.__paintInstalled = true;
       const step = () => {
         globalThis.__paintFrames += 1;
         globalThis.requestAnimationFrame(step);
       };
       globalThis.requestAnimationFrame(step);
       const timer = () => {
         globalThis.__paintTicks += 1;
         globalThis.setTimeout(timer, 16);
       };
       globalThis.setTimeout(timer, 16);
       return null;
     })()`,
  );
  let polls = 0;
  let lastFrames = 0;
  for (;;) {
    await sleep(1000);
    polls += 1;
    const total = await evaluate<number>(cdp, 'globalThis.__paintFrames');
    const timerTicks = await evaluate<number>(cdp, 'globalThis.__paintTicks');
    // Frames drawn in THIS window, not since installation. A page that painted briefly and stopped
    // must not be able to satisfy this out of a total it accumulated a minute ago.
    const inWindow = total - lastFrames;
    lastFrames = total;
    if (paintVerdict(inWindow, timerTicks) === 'painting') {
      return { ms: Date.now() - started, frames: inWindow, timerTicks, polls };
    }
    if (Date.now() > deadline) {
      const because =
        paintVerdict(inWindow, timerTicks) === 'warming'
          ? `its timer fired ${timerTicks} times over the same period, so the page is executing and is not being composited`
          : `its timer did not fire either, so the page is not executing at all -- waiting will not fix that and the cause is not compositing`;
      throw new Error(
        `[aegis:render-three] the browser never started painting: ${inWindow} animation frames in ` +
          `the last second, after ${timeoutMs}ms and ${polls} polls, and ${because}. ` +
          `The page describes itself as:\n${await describePage(cdp)}`,
      );
    }
  }
}

/** Poll `expression` until `accept` returns true, or throw on timeout. */
export async function until<T>(
  cdp: CdpSession,
  expression: string,
  accept: (value: T) => boolean,
  /**
   * 60s, and the number has an argument behind it rather than a feeling.
   *
   * This was 20s, which is comfortable on any development machine and was measured to be
   * *below the boot time of the slowest leg of our own CI matrix*. From run 30326965251,
   * both legs of the same commit:
   *
   *   ubuntu-latest, printed by the tests themselves:  boot 2042ms / 3106ms / 3719ms
   *   windows-latest, whole-suite ratio in that run:   662s vs 119s = 5.6x slower
   *   predicted worst boot on windows:                 3719 x 5.6 = 20.8s  >  20s deadline
   *
   * And that is exactly what happened: every case that has to boot the application page failed
   * on windows with this message, while the one case that does not boot anything — the blank-page
   * control — passed. A deadline a healthy machine misses is not a deadline, it is a slow-machine
   * detector, and it fails in the most expensive direction: it reddens on the machine you trust
   * least and blames whatever commit happened to land.
   *
   * 60s is 2.9x the measured windows figure, so a machine three times slower than windows-latest
   * still boots inside it, and it stays well under the 120s root `testTimeout` that catches a
   * genuine hang. It costs nothing when the page boots — `until` returns as soon as the condition
   * holds — and it is only ever spent when something is actually wrong.
   */
  timeoutMs = DEFAULT_UNTIL_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await evaluate<T>(cdp, expression);
    if (accept(value)) return value;
    if (Date.now() > deadline) {
      // The failures a mute timeout cannot tell apart: a page that died, a page that is alive and
      // never satisfied the condition, a page that never navigated, and a page whose renderer
      // could not be created. They have completely different causes and completely different
      // fixes, so the message states which one happened rather than only what was awaited.
      const seen = cdp.diagnostics;
      const warned = cdp.warnings;
      const parts: string[] = [];
      if (seen.length > 0) parts.push(`The page reported:\n  ${seen.join('\n  ')}`);
      else parts.push('The page reported no error.');
      // Only when there are no errors: a warning is noise beside a real exception, and the sole
      // reason it is here is that Chrome reports "software WebGL has been deprecated" at warning
      // level and then returns a null context, which presents as a page that fails silently.
      if (seen.length === 0 && warned.length > 0)
        parts.push(`It did warn:\n  ${warned.join('\n  ')}`);
      parts.push(`The page describes itself as:\n${await describePage(cdp)}`);
      throw new Error(
        `timed out waiting for ${expression} after ${timeoutMs}ms. ${parts.join(' ')}`,
      );
    }
    await sleep(40);
  }
}

/** A launched browser process and the DevTools port it is listening on. */
export interface LaunchedBrowser {
  /** The child process. Kill it when done. */
  process: ChildProcess;
  /** The DevTools port. */
  port: number;
  /** The temporary profile directory. */
  profile: string;
}

/** Options for {@link launchBrowser}. */
export interface LaunchOptions {
  /** Show a real window instead of running headless. */
  headed?: boolean;
  /**
   * DevTools port. **Omit it.** By default Chrome is given `--remote-debugging-port=0` and the
   * port it actually bound is read back from the profile's `DevToolsActivePort`, so two callers
   * can never pick the same number.
   *
   * The literals this replaced were a trap with a misleading failure. Two browsers launched
   * concurrently on the same port produce `browser did not expose a DevTools endpoint` — a message
   * that points at the browser, so the next person pays a full browser-debugging session for a
   * one-line cause. Measured: it reproduces reliably by relaunching on a port a previous instance
   * has not finished releasing. Nothing in the repository currently collides, which is exactly why
   * it was worth closing now: the cost lands on whoever adds the next browser test, and the
   * evidence they will be handed points somewhere else.
   */
  port?: number;
  /** Window size in CSS pixels. Defaults to 1280x720. */
  viewport?: { width: number; height: number };
  /**
   * Let animation frames run as fast as the page can produce them, instead of at the compositor's
   * pace.
   *
   * Headless Chrome paces `requestAnimationFrame` to a virtual display, and on this project's
   * machine that is ~30fps *for a page doing nothing at all* — measured, blank page, 30.0fps and
   * a p95 frame gap of 60.1ms. Any frame-time budget measured under that cap is a measurement of
   * the cap. Uncapped, the same blank page runs at 508fps with a p95 gap of 10.9ms, which leaves
   * room for the page's own cost to be what the number reflects.
   *
   * Only measurement should use this. The screenshot capture deliberately does not: it wants the
   * ordinary pacing a human gets, and it drives time explicitly anyway.
   */
  uncapFrameRate?: boolean;
}

/** Launch a headless browser with the DevTools endpoint open. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<LaunchedBrowser> {
  const executable = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'aegis-capture-'));
  // 0 asks the OS for a free port. Chrome then writes the one it actually bound into
  // `DevToolsActivePort` in the profile directory, which is how it is read back below.
  const requestedPort = options.port ?? 0;
  const viewport = options.viewport ?? { width: 1280, height: 720 };
  const args = [
    `--remote-debugging-port=${requestedPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    // These four remove Chrome's background/occlusion throttles. **They are NOT what makes
    // `windows-latest` paint, and believing they were cost two landings and four CI runs.**
    //
    // The original evidence was a blank-page control going 0fps -> 3861fps on run 30335228246 when
    // seven flags were added at once, credited to these four. That reading was confounded: nothing
    // isolated a subset, and the variable that actually moved was **when in the job the measurement
    // was taken**. The control that settled it (run 30362144330) held the flags fixed and varied
    // only position -- blocks of these four alone, then two more flags, then these four again:
    //
    //     leading block, these flags only:   0, 0, 0, 0 frames/3s   at 45-56s into the job
    //     trailing block, THE SAME FLAGS:  192, 193, 186, 187, 189  at 82s+
    //
    // The page's own `setTimeout` fired ~187 times and the window took 3000ms of wall clock in every
    // cell, so the page runs perfectly throughout and is simply not drawn for the first stretch of a
    // windows job. `ubuntu-latest` painted from its first launch in the same run and has never shown
    // a cold period. Waiting is what fixes it -- see {@link waitForPaint}, which is the actual repair
    // and which verifies the condition instead of assuming any of this.
    //
    // They are kept because none of them can *reduce* a frame rate -- they only remove throttling --
    // and because a warm-up that is merely shortened is still worth having. What is removed is the
    // claim that they are load-bearing. Unconditional rather than platform-gated on purpose: a
    // branch only one CI leg ever executes is a branch nobody can debug from a local machine.
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    // Dead option -- nothing in the repository passes `uncapFrameRate`, and it must stay that way.
    // Landing #20 removed it from the one caller after measuring a 60x dilation of a no-op CDP round
    // trip. Probe 1 (run 30361185588) then isolated which pair does the damage: `--disable-frame-
    // rate-limit` together with `--run-all-compositor-stages-before-draw` produced an unbounded rAF
    // spin -- 41 892 frames in a nominal 3s window that took 7.5s of wall clock -- starving the
    // transport until one round trip took **19 002ms**, against a 30s transport deadline. That is
    // run 30340124068's eight mute timeouts reproduced in isolation, and it is the one real finding
    // of the three flag probes. Kept rather than deleted so the measurement stays attached to the
    // thing it is about; `browser-playability.test.ts` pins that no call here re-enables it.
    ...(options.uncapFrameRate === true
      ? [
          '--disable-frame-rate-limit',
          '--disable-gpu-vsync',
          '--run-all-compositor-stages-before-draw',
        ]
      : []),
    'about:blank',
  ];
  if (options.headed !== true) args.unshift('--headless=new');
  const child = spawn(executable, args, { stdio: 'ignore' });

  // Discover the port Chrome actually bound. With `--remote-debugging-port=0` the number is not
  // known until Chrome has chosen it, and it publishes it in `DevToolsActivePort` (line 1 is the
  // port, line 2 the browser target path). Reading it is also a readiness signal in its own right:
  // the file does not exist until the endpoint is listening.
  //
  // The file is deleted on a clean exit, so a stale one from a previous run cannot be read here --
  // the profile directory is freshly created per launch a few lines above.
  const activePortFile = join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let port = requestedPort;
  for (;;) {
    if (port === 0) {
      // Read defensively. On Windows the file is briefly locked while Chrome writes it, which
      // surfaces as `EBUSY` and is indistinguishable from "not written yet" as far as this loop is
      // concerned -- both mean try again. Measured: it happens, and treating it as fatal turned a
      // healthy launch into a failure on the first run of this code.
      let line = '';
      try {
        line = readFileSync(activePortFile, 'utf8').split('\n')[0] ?? '';
      } catch {
        /* absent, or momentarily locked while being written */
      }
      const discovered = Number.parseInt(line, 10);
      if (Number.isInteger(discovered) && discovered > 0) port = discovered;
    }
    if (port !== 0) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {
        /* not up yet */
      }
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        port === 0
          ? '[aegis:render-three] browser never published a DevTools port. It was asked for an ' +
              'OS-allocated one, so this is not a port collision -- the process failed to start.'
          : `[aegis:render-three] browser did not expose a DevTools endpoint on port ${port}. ` +
              (requestedPort === 0
                ? 'The port was OS-allocated, so this is the browser failing to start.'
                : 'The port was requested explicitly; if another process holds it, omit the option ' +
                  'and let it be allocated.'),
      );
    }
    await sleep(200);
  }
  return { process: child, port, profile };
}

/** Open a new page target and attach a CDP session to it. */
export async function openPage(
  port: number,
  url: string,
  viewport = { width: 1280, height: 720 },
): Promise<CdpSession> {
  // The target is created BLANK and navigated afterwards, deliberately.
  //
  // `/json/new?<url>` asks Chrome to create a target already pointing at a URL. On
  // `windows-latest` it does not: run 30331670032 had a page that had been asked for
  // `http://127.0.0.1:<port>/` describe itself as
  //
  //     href: about:blank   readyState: complete   scripts: []   resources: []   bodyChars: 0
  //
  // Nothing was fetched, so nothing failed, so there was no error to report -- which is why eight
  // browser cases failed there for three runs with "the page reported no error" while ubuntu-latest
  // passed the same commit. Whether that Chrome rejects the percent-encoded query, ignores it, or
  // races the navigation is NOT established, and this does not depend on knowing: navigating
  // explicitly removes the dependence rather than guessing at it.
  //
  // It has a second benefit that was worth having anyway. Creating the target blank means the CDP
  // domains are enabled before the real document starts loading, so load-time failures cannot be
  // missed even by a Chrome that does not replay its buffered log entries.
  const created = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };
  const cdp = await CdpSession.connect(created.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Browser-level errors — a WebGL context that cannot be created, a module that 404s — are
  // reported through Log, not Runtime, and are exactly the failures a headless CI runner produces
  // that a developer's machine never does.
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (url !== 'about:blank') {
    const navigation = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
    // Chrome reports a refused navigation here rather than throwing. Unchecked, it produces a page
    // that sits on about:blank and a caller that waits for application state that can never come.
    if (navigation.errorText !== undefined && navigation.errorText !== '')
      throw new Error(`[aegis:render-three] navigation to ${url} failed: ${navigation.errorText}`);
    // And the precondition that actually bit us: a navigation can be accepted and still not
    // happen. A page that never left about:blank must say so HERE, where the URL is known, rather
    // than sixty seconds later as an unexplained timeout somewhere else.
    //
    // 30s, and the number is chosen by containment rather than by feel. This interval is a strict
    // sub-interval of the boot wait that every caller performs next -- the document must commit
    // before any application state can exist -- and the worst *whole boot* ever measured on this
    // matrix is 22 826ms (windows, under full-suite load, landing #14). So 30s sits above the worst
    // observation of the interval that contains this one, and it cannot fire before the boot wait
    // would have. It was 60s, which is not wrong so much as unaffordable: three 60s deadlines were
    // stacked inside a 90s vitest budget, so the budget always fired first and the caller died
    // saying nothing. See the deadline table at the head of `browser-playability.test.ts`.
    await until<string>(
      cdp,
      'String(location.href)',
      (href) => href !== 'about:blank',
      NAVIGATION_TIMEOUT_MS,
    ).catch(() => {
      throw new Error(
        `[aegis:render-three] asked the browser to open ${url}, but the page is still on ` +
          'about:blank. The navigation was accepted and never happened.',
      );
    });
  }
  // Creating a target with `/json/new?<url>` activates the new tab as a side effect. Creating it
  // blank and navigating does NOT, and the consequence is invisible until something asks for a
  // capability that requires focus. Measured, one variable, two states:
  //
  //     /json/new?<url>                        hasFocus=true   pointer lock engaged
  //     blank + Page.navigate                  hasFocus=false  pointer lock REFUSED
  //     blank + Page.navigate + bringToFront   hasFocus=true   pointer lock engaged
  //
  // `poc/capture.mjs` failed 2 of 2 on the middle row and passed 2 of 2 on the first, which is how
  // this was attributed rather than guessed at: the fps capture clicks to take pointer lock, and
  // Chrome answers an unfocused document with `WrongDocumentError`. So this line is not defensive
  // tidying -- it restores the one side effect the old creation path was silently relying on.
  await cdp.send('Page.bringToFront');
  // ...and then WAIT for it, which is the same lesson as the navigation check above, one line
  // lower. `Page.bringToFront` is acknowledged by the BROWSER process; `document.hasFocus()` is
  // answered by the RENDERER. Awaiting the command proves it was accepted, not that it arrived --
  // exactly the distinction that made "the navigation was accepted and never happened" worth its
  // own check.
  //
  // Under load those two moments are measurably apart. Four browsers brought up concurrently,
  // 16 samples, polling every 25ms:
  //
  //     15 samples  hasFocus=true at the moment bringToFront resolved
  //      1 sample   hasFocus=false, becoming true 213ms later
  //      0 samples  still false after 3s
  //
  // Nothing there is contended: all four held focus at once, so this is not one window winning a
  // fight for the foreground -- it is one page's focus not having reached its renderer yet. That
  // distinction is only visible by polling: under contention the loser stays false, and this
  // converged on its own.
  //
  // What this is NOT is a live production hazard, and that correction is worth keeping because the
  // first version of this comment claimed otherwise. `capture.ts` is the only caller that takes
  // pointer lock, and it does so after `waitForBoot`, which was measured on the real fps page at
  // 860/1166/1002ms -- roughly a second of module loading between this line and the click, against
  // a 213ms lag. The margin is ~800ms, not the "37ms" first claimed here, which compared the sleep
  // *after* the click instead of the boot *before* it.
  //
  // The wait earns its place anyway: `openPage`'s contract is that it hands back a focused page,
  // asserted as such by `browser-diagnostics.test.ts`, and it was previously true on average rather
  // than guaranteed. Today's ~800ms margin is incidental -- it is page boot time, not a designed
  // gap -- so the next caller to want pointer lock sooner would inherit a race nobody restated.
  await until<boolean>(
    cdp,
    'document.hasFocus()',
    (focused) => focused === true,
    FOCUS_TIMEOUT_MS,
  ).catch(() => {
    throw new Error(
      '[aegis:render-three] the page was brought to the front and never took focus. Capabilities ' +
        'that require it (pointer lock, and therefore mouse-look) would be refused with ' +
        'WrongDocumentError.',
    );
  });
  return cdp;
}

/**
 * Close every open page target and **verify that they are gone**, so one measurement cannot be
 * starved by the previous one.
 *
 * The verification is the point, and its absence was a real hole. The old body issued a close for
 * each target and slept 150ms, which asserts nothing: `/json/close` asks Chrome to tear a renderer
 * down, and a renderer whose main thread is inside a tight loop does not necessarily stop when
 * asked. A page that refuses to die keeps consuming the CPU the *next* page needs, and the symptom
 * lands on the innocent successor — in run 30347429388, two cases failed on `Page.enable (id 1)`,
 * the first command of a freshly created session, which is what a browser looks like when it is
 * still busy with the target somebody believed was closed.
 *
 * So the postcondition this function has always claimed in its own name is now checked, and its
 * failure is named. A fixed sleep is a hope; a poll with a deadline is a measurement.
 */
export async function closeAllPages(port: number, timeoutMs = TRANSPORT_TIMEOUT_MS): Promise<void> {
  const pages = async (): Promise<{ id: string; type: string }[]> => {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
      id: string;
      type: string;
    }[];
    return targets.filter((target) => target.type === 'page');
  };

  for (const target of await pages()) {
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = await pages();
    if (left.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `[cdp] ${left.length} page target(s) were asked to close and are still open after ` +
          `${timeoutMs}ms. A page whose main thread never yields cannot be torn down on request, ` +
          `and it goes on competing for the CPU that the next measurement needs — so the failure ` +
          `would otherwise land on whichever case ran next, which is not the one at fault.`,
      );
    }
    await sleep(50);
  }
}

/** Save a PNG screenshot of the page. */
export async function screenshot(cdp: CdpSession, file: string): Promise<void> {
  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}
