/** Shared production voice cleanup and gain automation, extracted from render-three audio. */
export interface OwnedAudioVoice {
  source: AudioBufferSourceNode;
  gain?: GainNode;
  panner?: PannerNode;
  started: boolean;
}
export interface GainRamp {
  from: number;
  to: number;
  start: number;
  end: number;
}

export function cleanupAudioActions(actions: readonly (() => void)[]): unknown[] {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      action();
    } catch (cause) {
      errors.push(cause);
    }
  }
  return errors;
}

export function releaseAudioVoice(voice: OwnedAudioVoice, stop = true): unknown[] {
  voice.source.onended = null;
  return cleanupAudioActions([
    () => {
      if (stop && voice.started) voice.source.stop();
    },
    () => voice.source.disconnect(),
    () => voice.gain?.disconnect(),
    () => voice.panner?.disconnect(),
    () => {
      voice.source.buffer = null;
    },
  ]);
}

export function rampAudioGain(
  gain: AudioParam,
  previous: GainRamp | undefined,
  now: number,
  volume: number,
  seconds: number,
): GainRamp {
  const from =
    previous === undefined
      ? gain.value
      : previous.from +
        (previous.to - previous.from) *
          (previous.end === previous.start
            ? 1
            : Math.min(1, Math.max(0, (now - previous.start) / (previous.end - previous.start))));
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(from, now);
  gain.linearRampToValueAtTime(volume, now + seconds);
  return { from, to: volume, start: now, end: now + seconds };
}
