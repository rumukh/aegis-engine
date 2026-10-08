import { describe, expect, it } from 'vitest';
import * as runtime from '@aegis/runtime';
import { CutscenePlayer, PuppetModel } from '@aegis/browser/animation';
import type { ClipFile, CutsceneFile, CutsceneHost, RigFile } from '@aegis/browser/animation';
import { benchActions, benchAdapter, syntheticContent } from '../scripts/bench-runtime-content.mjs';
import { documents } from '../poc/animation-lab/fixture.mjs';

/**
 * F07 / K01: presentation never changes authoritative state. A runtime host advances a real
 * session, then 10,000 animation frames of four composed puppets and a looping cutscene run
 * against it; the authoritative hash, snapshot and revision must be byte-identical afterwards.
 * The stage itself is the same model plus a renderer (exercised in the browser specs).
 */
describe('animation never changes authoritative state (F07)', () => {
  it('renders 10,000 frames with puppets and a cutscene without touching the runtime host', async () => {
    const { createRuntimeHost, requireValue, success } = runtime;
    const content = syntheticContent(0.2);
    const host = createRuntimeHost({
      // The benchmark adapter is untyped JavaScript; the host validates it at runtime.
      adapter: benchAdapter(runtime) as never,
      content,
      seed: 'k01',
      checkpoint: async () => success(undefined),
    });
    for (const action of benchActions(content, 20)) requireValue(await host.dispatch(action));
    const before = {
      hash: host.hash(),
      snapshot: JSON.stringify(host.snapshot()),
      revision: host.getStatus().revision,
      view: JSON.stringify(host.getView()),
    };

    const docs = documents() as unknown as (RigFile | ClipFile | CutsceneFile)[];
    const rigs = new Map(
      docs.filter((d): d is RigFile => d.format === 'aegis-rig/1').map((d) => [d.id, d]),
    );
    const clips = new Map(
      docs.filter((d): d is ClipFile => d.format === 'aegis-clip/1').map((d) => [d.id, d]),
    );
    const cutscene = docs.find((d): d is CutsceneFile => d.format === 'aegis-cutscene/1')!;
    const puppets = ['fox', 'cat', 'rabbit', 'bear'].map((name, i) => {
      const puppet = new PuppetModel({
        rigs,
        clips,
        composition: {
          rig: `avatar.${name}`,
          tints: { scarf: '#2f6fb3' },
          accessories: [
            { slot: 'scarf', rig: 'acc.scarf.long' },
            { slot: 'hat', rig: 'acc.hat.cap' },
            { anchor: 'badge', rig: 'acc.badge' },
          ],
        },
        at: { x: 500 + i * 500, y: 1450 },
        seed: name,
      });
      puppet.behave({ breathe: {}, blink: {} });
      puppet.play('sway', { at: 0, layer: 'idle', loop: true });
      return puppet;
    });
    const fake: CutsceneHost = {
      reset: () => undefined,
      background: () => 0.5,
      camera: (_t, m, o) => (o.instant ? 0 : m.duration),
      enter: (_a, _f, _t, m, o) => (o.instant ? 0 : (m.duration ?? 1)),
      exit: (_a, _t, m, o) => (o.instant ? 0 : (m.duration ?? 1)),
      move: () => 1,
      pose: () => 1,
      emote: () => 0.5,
      line: () => ({ outcome: () => 'completed' }),
      stopLine: () => undefined,
      music: () => undefined,
      atmosphere: () => undefined,
      sfx: () => undefined,
      effect: (_e, _a, d, o) => (o.instant ? 0 : d),
      transition: () => 0.5,
      settle: () => undefined,
    };
    const player = new CutscenePlayer(cutscene, fake);
    let draws = 0;
    let cycles = 0;
    player.play(0);
    for (let frame = 0; frame < 10_000; frame++) {
      const t = frame / 60;
      if (frame % 90 === 0)
        puppets[frame % 4]!.play(['wave', 'nod', 'think'][frame % 3]!, { at: t });
      for (const puppet of puppets) draws += puppet.pose(t).length;
      player.update(t);
      if (player.status() === 'awaiting-input') player.next(t);
      if (player.status() === 'completed') {
        cycles++;
        player.replay(t);
      }
    }
    expect(draws).toBeGreaterThan(10_000 * 4 * 15);
    expect(cycles).toBeGreaterThan(3);
    expect({
      hash: host.hash(),
      snapshot: JSON.stringify(host.snapshot()),
      revision: host.getStatus().revision,
      view: JSON.stringify(host.getView()),
    }).toEqual(before);
    await host.dispose();
  });
});
