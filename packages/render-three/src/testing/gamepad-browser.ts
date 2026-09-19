import { evaluate } from '../browser.js';
import type { CdpSession } from '../browser.js';

/** Supply hardware samples at navigator's boundary, never through a gameplay/debug input hook. */
export async function installVirtualPad(cdp: CdpSession): Promise<void> {
  await evaluate(
    cdp,
    `(() => {
    globalThis.__padPolls = 0;
    globalThis.__padSamples = [];
    globalThis.__setVirtualPad = (axes = [0, 0, 0, 0], down = [], connected = true) => {
      globalThis.__virtualPad = connected ? Object.freeze({
        index: 0, id: 'Aegis virtual standard controller — not physical hardware',
        mapping: 'standard', connected: true,
        axes: Object.freeze([...axes]),
        buttons: Object.freeze(Array.from({length: 17}, (_, index) => Object.freeze({
          pressed: down.includes(index), touched: down.includes(index),
          value: down.includes(index) ? 1 : 0,
        }))),
      }) : null;
    };
    globalThis.__setVirtualPad();
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        globalThis.__padPolls++;
        globalThis.__padSamples.push({
          at: performance.now(), axes: globalThis.__virtualPad?.axes ?? [0, 0, 0, 0],
        });
        return Object.freeze([globalThis.__virtualPad]);
      },
    });
  })()`,
  );
}

export async function gamepadFrames(cdp: CdpSession, count = 3): Promise<void> {
  await evaluate(
    cdp,
    `new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('controller frame wait stalled')), 15000);
    let left = ${count};
    const step = () => {
      if (--left === 0) { clearTimeout(timeout); resolve(null); }
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })`,
  );
}

export async function setPad(
  cdp: CdpSession,
  axes = [0, 0, 0, 0],
  down: number[] = [],
  connected = true,
): Promise<void> {
  await evaluate(
    cdp,
    `globalThis.__setVirtualPad(${JSON.stringify(axes)}, ${JSON.stringify(down)}, ${connected})`,
  );
}
