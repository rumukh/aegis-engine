import { setImmediate } from 'node:timers';

// Capture before individual tests install fake timers.
const nativeImmediate = setImmediate;

export function yieldWorkerIO(): Promise<void> {
  return new Promise((resolve) => nativeImmediate(resolve));
}
