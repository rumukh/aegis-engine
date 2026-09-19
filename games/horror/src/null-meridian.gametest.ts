import { Transform, hashString } from '@aegis/core';
import { Health } from '@aegis/content';
import { defineGameTest, expectSim } from '@aegis/harness';
import type { SimResult } from '@aegis/harness';
import { HorrorMission, HorrorPlayer, HorrorStatus, HorrorThreat } from './components.js';
import { nullMeridianPlugin } from './plugin.js';
import {
  CAUGHT_ROUTE,
  CAUGHT_TICKS,
  LOCKED_ROUTE,
  SCENE,
  SEED,
  WIN_ROUTE,
  WIN_TICKS,
} from './routes.js';

// Re-recorded on 2026-09-18 after approved wall-face prop relocations removed pass-through
// kiosks, and the revised route added a genuine chase/cover escape. Named win/lose assertions
// passed first: seed null-meridian-1, 8217 ticks at 60 Hz, play/null-meridian.input.
// Includes the explicit ending-aware music phase; later asset-only edits must not move pins.
export const GOLDEN_HASH = '7a8eeb4d3cdd4dae';
export const GOLDEN_TRAJECTORY = '472e64afc4a7ab21';

export function assertMissionCompleted(result: SimResult): void {
  expectSim(result)
    .eventEmitted('horror.fuse.taken', 1)
    .eventEmitted('horror.maintenance.read', 1)
    .eventEmitted('horror.bus.isolated', 1)
    .eventEmitted('horror.power.restored', 1)
    .eventEmitted('horror.triage.played', 1)
    .eventEmitted('horror.recorder.recovered', 1)
    .eventEmitted('horror.coolant.isolated', 1)
    .eventEmitted('horror.uplink.transmitted', 1)
    .eventEmitted('horror.threat.awakened', 1)
    .eventEmitted('horror.threat.step')
    .eventEmitted('horror.threat.chase', 1)
    .eventEmitted('horror.threat.search', 1)
    .eventEmitted('horror.threat.evaded', 1)
    .eventEmitted('level.completed', 1)
    .eventNotEmitted('player.died')
    .eventNotEmitted('weapon.fired')
    .holds('the living visitor escaped from the actual capsule, x >= 27 and z >= 36', (run) => {
      const player = run.query({ has: [HorrorPlayer, Transform, Health] }).one();
      const pos = player.get(Transform).position;
      return { ok: pos.x >= 27 && pos.z >= 36 && player.get(Health).current === 100, actual: pos };
    })
    .holds(
      'all three evidence records were investigated; the responder genuinely patrolled',
      (run) => {
        const mission = run
          .query({ has: [HorrorMission] })
          .one()
          .get(HorrorMission);
        const ai = run
          .query({ has: [HorrorThreat] })
          .one()
          .get(HorrorThreat);
        return {
          ok: mission.evidence === 3 && ai.patrolIndex >= 8,
          actual: { evidence: mission.evidence, patrolIndex: ai.patrolIndex },
        };
      },
    )
    .holds(
      'completion occurs only after the spatial diagnosis and evidence chain, on tick 8153',
      (run) => {
        const event = run.events.history().find((entry) => entry.type === 'level.completed');
        return { ok: event?.tick === 8153, actual: event?.tick, expected: 8153 };
      },
    );
}

export const nullMeridian = defineGameTest({
  name: 'null meridian: diagnose, restore power, investigate, avoid the responder and escape',
  scene: SCENE,
  seed: SEED,
  ticks: WIN_TICKS,
  input: WIN_ROUTE,
  options: { plugin: nullMeridianPlugin, captureHistory: false },
  expect(result) {
    assertMissionCompleted(result);
    expectSim(result)
      .hashEquals(GOLDEN_HASH)
      .holds(
        'the complete 8217-tick trajectory matches the deliberately recorded literal',
        (run) => ({
          ok:
            run.tickHashes.length === 8217 &&
            hashString(run.tickHashes.join('|')) === GOLDEN_TRAJECTORY,
          actual: hashString(run.tickHashes.join('|')),
          expected: GOLDEN_TRAJECTORY,
        }),
      );
  },
});

export const nullMeridianCaught = defineGameTest({
  name: 'null meridian (lose): confront the responder and fail to evade its warned catch',
  scene: SCENE,
  seed: SEED,
  ticks: CAUGHT_TICKS,
  input: CAUGHT_ROUTE,
  options: { plugin: nullMeridianPlugin, captureHistory: false },
  expect(result) {
    expectSim(result)
      .eventEmitted('horror.power.restored', 1)
      .eventEmitted('horror.threat.chase')
      .eventEmitted('horror.threat.warning')
      .eventEmitted('player.died', 1)
      .eventNotEmitted('level.completed')
      .eventNotEmitted('horror.recorder.recovered')
      .holds('the captured visitor is told the signal is lost, not instructed to move', (run) => ({
        ok:
          run
            .query({ has: [HorrorPlayer, HorrorStatus] })
            .one()
            .get(HorrorStatus).threat === 'Signal lost. The responder has secured the visitor.',
        actual: run
          .query({ has: [HorrorPlayer, HorrorStatus] })
          .one()
          .get(HorrorStatus).threat,
        expected: 'Signal lost. The responder has secured the visitor.',
      }))
      .holds('the warned physical catch takes the visitor health to zero', (run) => {
        const health = run
          .query({ has: [HorrorPlayer, Health] })
          .one()
          .get(Health).current;
        return { ok: health === 0, actual: health, expected: 0 };
      });
  },
});

export const nullMeridianLocked = defineGameTest({
  name: 'null meridian (locked): rushing the observation door cannot complete any objective',
  scene: SCENE,
  seed: SEED,
  ticks: 1800,
  input: LOCKED_ROUTE,
  options: { plugin: nullMeridianPlugin, captureHistory: false },
  expect(result) {
    expectSim(result)
      .eventNotEmitted('horror.power.restored')
      .eventNotEmitted('horror.recorder.recovered')
      .eventNotEmitted('level.completed')
      .holds('the capsule is physically stopped south of observation, 33 < z < 33.2', (run) => {
        const z = run
          .query({ has: [HorrorPlayer, Transform] })
          .one()
          .get(Transform).position.z;
        return { ok: z > 33 && z < 33.2, actual: z, expected: '33 < z < 33.2' };
      });
  },
});
