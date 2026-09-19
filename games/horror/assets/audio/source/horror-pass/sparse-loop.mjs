import assert from 'node:assert/strict';

export function assembleSparseLoop(source, sampleRate, durationSeconds, gestures) {
  assert.ok(source instanceof Float32Array && source.length > 0);
  assert.ok(Number.isInteger(sampleRate) && sampleRate > 0);
  const frames = Math.round(durationSeconds * sampleRate);
  assert.ok(Number.isSafeInteger(frames) && frames > source.length);
  assert.ok(gestures.length >= 2);
  for (const sample of source) assert.ok(Number.isFinite(sample));
  const samples = new Float32Array(frames);
  const active = [];
  let previousEnd = 0;
  for (const gesture of gestures) {
    const startFrame = Math.round(gesture.startSeconds * sampleRate);
    const endFrame = startFrame + source.length;
    assert.ok(Number.isFinite(gesture.gain) && gesture.gain > 0 && gesture.gain <= 1);
    assert.ok(
      startFrame >= previousEnd + 2 * sampleRate,
      'At least two seconds of exact quiet before each gesture',
    );
    assert.ok(endFrame <= frames - 2 * sampleRate, 'At least two seconds of quiet before the wrap');
    for (let frame = 0; frame < source.length; frame++) {
      samples[startFrame + frame] = source[frame] * gesture.gain;
    }
    active.push({ startFrame, endFrame, gain: gesture.gain });
    previousEnd = endFrame;
  }
  const quiet = [];
  let startFrame = 0;
  for (const interval of active) {
    quiet.push({ startFrame, endFrame: interval.startFrame });
    startFrame = interval.endFrame;
  }
  quiet.push({ startFrame, endFrame: frames });
  const quietFrames = quiet.reduce(
    (sum, interval) => sum + interval.endFrame - interval.startFrame,
    0,
  );
  assert.ok(
    quietFrames / frames >= 0.8,
    'At least eighty percent of the loop must be authored quiet',
  );
  return { samples, active, quiet, quietFraction: quietFrames / frames };
}

export function inspectQuiet(samples, quiet, sampleRate, guardSeconds = 0.08) {
  const guard = Math.round(guardSeconds * sampleRate);
  return quiet.map((interval) => {
    let peak = 0;
    const start = interval.startFrame === 0 ? 0 : interval.startFrame + guard;
    const end = interval.endFrame === samples.length ? samples.length : interval.endFrame - guard;
    assert.ok(end > start);
    for (let frame = start; frame < end; frame++) peak = Math.max(peak, Math.abs(samples[frame]));
    return { startSeconds: start / sampleRate, endSeconds: end / sampleRate, peak };
  });
}
