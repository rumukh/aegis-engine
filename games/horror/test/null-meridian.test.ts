import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSchedule, Name, Transform, hashString } from '@aegis/core';
import type { World } from '@aegis/core';
import { Health, parseScene } from '@aegis/content';
import { runGameTest, runScene } from '@aegis/harness';
import type { ModePlugin, SimResult } from '@aegis/harness';
import { FPS_COLLISION, FPS_SYSTEMS, LookState, cellAtWorld } from '@aegis/mode-fps';
import { describe, expect, it } from 'vitest';
import {
  HorrorInteractable,
  HorrorMission,
  HorrorPlayer,
  HorrorStatus,
  HorrorThreat,
} from '../src/components.js';
import { HORROR_SYSTEMS } from '../src/systems.js';
import { nullMeridianPlugin } from '../src/plugin.js';
import { clearSight } from '../src/navigation.js';
import {
  nullMeridian,
  nullMeridianCaught,
  nullMeridianLocked,
  assertMissionCompleted,
} from '../src/null-meridian.gametest.js';
import { SCENE, WIN_ROUTE, CAUGHT_ROUTE, LOCKED_ROUTE } from '../src/routes.js';

function named(world: World, name: string) {
  const found = world
    .query({ has: [Name] })
    .views()
    .find((entity) => entity.get(Name).value === name);
  if (found === undefined) throw new Error(`Missing fixture subject: ${name}`);
  return found;
}

function position(world: World, name: string, x: number, z: number): void {
  named(world, name).get(Transform).position = { x, y: 0, z };
}

function mission(world: World) {
  return named(world, 'mission').get(HorrorMission);
}

function open(world: World, keys: string): void {
  const grid = world.getResource(FPS_COLLISION);
  if (grid === undefined) throw new Error('Missing fixture collision grid');
  for (const cell of grid.cells) if (cell.door && keys.includes(cell.key)) cell.solid = false;
}

function fixture(setup: (world: World) => void): ModePlugin {
  return {
    ...nullMeridianPlugin,
    init(world) {
      nullMeridianPlugin.init?.(world);
      position(world, 'responder', 15, 3);
      setup(world);
    },
  };
}

async function focused(setup: (world: World) => void, input = 'hold Interact 0..180', ticks = 180) {
  return runScene(SCENE, { plugin: fixture(setup), input, ticks, captureTickHashes: false });
}

function count(result: SimResult, type: string): number {
  return result.events.history().filter((event) => event.type === type).length;
}

const execute = promisify(execFile);

// Hashing the full station trajectory is deliberately synchronous simulation work. Keep it in
// an awaited child so Vitest's worker can still answer RPC while all 8217 hashes are checked.
async function compiledSpec(exportName: string) {
  const { stdout } = await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { runGameTest } from '@aegis/harness';
    import * as specs from './games/horror/dist/null-meridian.gametest.js';
    const outcome = await runGameTest(specs[${JSON.stringify(exportName)}]);
    process.stdout.write(JSON.stringify({
      name: outcome.name, passed: outcome.passed, assertions: outcome.assertions,
      checked: outcome.checked,
    }));
    if (!outcome.passed) {
      console.error(outcome.error?.stack ?? 'Compiled game test failed');
      process.exitCode = 1;
    }
  `,
    ],
    { cwd: process.cwd(), timeout: 110_000, maxBuffer: 512 * 1024 },
  );
  return JSON.parse(stdout) as {
    name: string;
    passed: boolean;
    assertions: number;
    checked: string[];
  };
}

describe('NULL MERIDIAN authored mission', () => {
  for (const [exportName, spec] of [
    ['nullMeridian', nullMeridian],
    ['nullMeridianCaught', nullMeridianCaught],
    ['nullMeridianLocked', nullMeridianLocked],
  ] as const) {
    it(spec.name, async () => {
      const outcome = await compiledSpec(exportName);
      expect(outcome.passed).toBe(true);
      expect(outcome.name).toBe(spec.name);
      expect(outcome.assertions).toBeGreaterThan(2);
      expect(outcome.checked).toHaveLength(outcome.assertions);
    });
  }

  it('ships exactly the input scripts used by headless acceptance', () => {
    const commands = (input: string) =>
      input
        .split('\n')
        .map((line) => line.split('#')[0]?.trim())
        .filter(Boolean);
    for (const [file, input] of [
      ['null-meridian.input', WIN_ROUTE],
      ['caught.input', CAUGHT_ROUTE],
      ['locked.input', LOCKED_ROUTE],
    ]) {
      expect(commands(readFileSync(`games/horror/play/${file}`, 'utf8'))).toEqual(
        commands(input ?? ''),
      );
    }
  });

  it('the real authored floorplan and anchors validate, and carry no weapon', async () => {
    const scene = parseScene(readFileSync(SCENE, 'utf8'));
    expect(scene.diagnostics).toEqual([]);
    expect(scene.value).toBeDefined();
    const run = await runScene(SCENE, { plugin: nullMeridianPlugin, ticks: 0 });
    expect(run.query({ has: ['Hitscan'] }).count()).toBe(0);
    const grid = run.world.getResource(FPS_COLLISION);
    expect([grid?.width, grid?.height, grid?.tileSize]).toEqual([31, 41, 1]);
    expect(run.query({ has: [HorrorInteractable] }).count()).toBe(11);
  });

  it('named mission assertions fail with zero ticks, no schedule, or no interaction system', async () => {
    for (const plugin of [
      { ...nullMeridianPlugin, systems: () => createSchedule() },
      {
        ...nullMeridianPlugin,
        systems: () =>
          createSchedule()
            .addAll(FPS_SYSTEMS)
            .addAll(HORROR_SYSTEMS.filter((system) => system.name !== 'horror.interaction')),
      },
    ]) {
      const result = await runScene(SCENE, {
        plugin,
        ticks: 2100,
        input: WIN_ROUTE,
        captureTickHashes: false,
      });
      expect(() => assertMissionCompleted(result)).toThrow(/horror.fuse.taken/);
    }
    const zero = await runScene(SCENE, { plugin: nullMeridianPlugin, ticks: 0 });
    expect(() => assertMissionCompleted(zero)).toThrow(/horror.fuse.taken/);
  });

  it('the catch spec fails when the threat system is removed', async () => {
    const outcome = await runGameTest({
      ...nullMeridianCaught,
      options: {
        plugin: {
          ...nullMeridianPlugin,
          systems: () =>
            createSchedule()
              .addAll(FPS_SYSTEMS)
              .addAll(HORROR_SYSTEMS.filter((system) => system.name !== 'horror.threat')),
        },
        captureTickHashes: false,
      },
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.error?.message).toContain('horror.threat.chase');
  });
});

describe('spatial interaction and recoverable diagnosis', () => {
  it('all eleven authored wall-mounted controls are backed by real solid cells and usable from open floor', async () => {
    const approaches = [
      ['arrival-terminal', 18, 6, 90, 19.55, 6, 'horror.arrival.read'],
      ['fuse-locker', 3, 10, 180, 3, 8.45, 'horror.fuse.taken'],
      ['maintenance-note', 9, 17, -90, 7.45, 17, 'horror.maintenance.read'],
      ['service-wheel', 4, 22, 0, 4, 23.55, 'horror.service.opened'],
      ['bus-isolator', 9, 30, 0, 9, 31.55, 'horror.bus.isolated'],
      ['power-console', 3, 30, 0, 3, 31.55, 'horror.power.restored'],
      ['triage-recorder', 28, 13, 90, 29.55, 13, 'horror.triage.played'],
      ['archive-recorder', 21, 30, 0, 21, 31.55, 'horror.recorder.recovered'],
      ['coolant-valve', 3, 22, 0, 3, 23.55, 'horror.coolant.isolated'],
      ['uplink-console', 6, 38, 0, 6, 39.55, 'horror.uplink.transmitted'],
      ['evac-control', 28, 38, 90, 29.55, 38, 'level.completed'],
    ] as const;
    for (const [name, x, z, yaw, behindX, behindZ, event] of approaches) {
      const run = await focused(
        (world) => {
          position(world, 'player', x, z);
          named(world, 'player').get(LookState).yawDeg = yaw;
          Object.assign(mission(world), {
            fuse: true,
            service: true,
            busIsolated: true,
            power: true,
            visitorToken: true,
            recorder: true,
            coolant: true,
            uplink: true,
          });
          open(world, 'DPAOE');
          const control = named(world, name).get(HorrorInteractable);
          control.selection = name === 'power-console' ? 2 : 1;
          const grid = world.getResource(FPS_COLLISION);
          assert.ok(grid);
          const anchor = named(world, name).get(Transform).position;
          expect(cellAtWorld(grid, anchor.x, anchor.z).solid, `${name}: interaction point`).toBe(
            false,
          );
          expect(cellAtWorld(grid, behindX, behindZ).solid, `${name}: physical backing`).toBe(true);
          expect(cellAtWorld(grid, x, z).solid, `${name}: visitor approach`).toBe(false);
        },
        'hold Interact 0..151',
        151,
      );
      expect(count(run, event), name).toBe(1);
      expect(count(run, 'horror.interaction.denied'), name).toBe(0);
    }
  });
  it('the wall-mounted arrival terminal is usable without self-occlusion and its backing wall is solid', async () => {
    const read = await focused(
      (world) => {
        position(world, 'player', 18, 6);
        named(world, 'player').get(LookState).yawDeg = 90;
      },
      'press Interact @0',
      1,
    );
    expect(count(read, 'horror.arrival.read')).toBe(1);
    const approach = await focused(
      (world) => {
        position(world, 'player', 18, 6);
        named(world, 'player').get(LookState).yawDeg = 90;
      },
      'axis Forward 1 0..120',
      120,
    );
    expect(named(approach.world, 'player').get(Transform).position.x).toBeLessThanOrEqual(19.2);
    const centerline = await focused(() => {}, 'axis Forward 1 0..120', 120);
    expect(named(centerline.world, 'player').get(Transform).position.z).toBeCloseTo(7, 8);
  });
  it('cannot use a panel from a distance, while facing away, or through a wall', async () => {
    const setups = [
      (world: World) => position(world, 'player', 3, 12),
      (world: World) => {
        position(world, 'player', 3, 10);
        named(world, 'player').get(LookState).yawDeg = 0;
      },
      (world: World) => {
        position(world, 'player', 11.15, 27);
        position(world, 'fuse-locker', 12.75, 27);
        named(world, 'player').get(LookState).yawDeg = 90;
      },
    ];
    for (const setup of setups) {
      const run = await focused(setup);
      expect(count(run, 'horror.fuse.taken')).toBe(0);
      expect(mission(run.world).fuse).toBe(false);
    }
    const reachable = await focused((world) => {
      position(world, 'player', 3, 10);
      named(world, 'player').get(LookState).yawDeg = 180;
    });
    expect(count(reachable, 'horror.fuse.taken')).toBe(1);
  });

  it('holding interact acquires one fuse and never activates a different nearby panel', async () => {
    const run = await focused(
      (world) => {
        position(world, 'player', 3, 10);
        named(world, 'player').get(LookState).yawDeg = 180;
        position(world, 'service-wheel', 4, 10);
      },
      'hold Interact 0..300',
      300,
    );
    expect(count(run, 'horror.fuse.taken')).toBe(1);
    expect(count(run, 'horror.service.opened')).toBe(0);
  });

  it('releasing a machinery hold resets progress instead of accumulating disconnected taps', async () => {
    const run = await focused(
      (world) => position(world, 'player', 4, 22),
      'hold Interact 0..70\nhold Interact 80..150',
      150,
    );
    expect(count(run, 'horror.service.opened')).toBe(0);
    expect(named(run.world, 'service-wheel').get(HorrorInteractable).progress).toBe(70);
  });

  it('rejects the empty fuse socket, connected rescue bus and both unsafe power routes', async () => {
    for (const [fuse, busIsolated, selection] of [
      [false, false, 2],
      [true, false, 2],
      [true, true, 0],
      [true, true, 1],
    ] as const) {
      const run = await focused((world) => {
        position(world, 'player', 3, 30);
        Object.assign(mission(world), { fuse, busIsolated });
        named(world, 'power-console').get(HorrorInteractable).selection = selection;
      });
      expect(count(run, 'horror.interaction.denied')).toBe(1);
      expect(count(run, 'horror.power.restored')).toBe(0);
      expect(mission(run.world).fuse).toBe(fuse);
      expect(named(run.world, 'power-console').get(HorrorInteractable).used).toBe(false);
    }
  });

  it('recovers from an unsafe selection by visibly choosing MEDICAL / ARCHIVE', async () => {
    const run = await focused(
      (world) => {
        position(world, 'player', 3, 30);
        Object.assign(mission(world), { fuse: true, busIsolated: true });
      },
      'press Interact @0\npress Select @5\npress Select @7\nhold Interact 10..100',
      101,
    );
    expect(count(run, 'horror.interaction.denied')).toBe(1);
    expect(count(run, 'horror.power.restored')).toBe(1);
    expect(mission(run.world).power).toBe(true);
    expect(named(run.world, 'power-console').get(HorrorInteractable).selection).toBe(2);
  });

  it('requires infirmary visitor authorization even after restoring archive power', async () => {
    for (const token of [false, true]) {
      const run = await focused((world) => {
        position(world, 'player', 21, 30);
        named(world, 'player').get(LookState).yawDeg = 0;
        Object.assign(mission(world), { power: true, visitorToken: token });
        open(world, 'PA');
      });
      expect(count(run, 'horror.recorder.recovered')).toBe(token ? 1 : 0);
      expect(count(run, 'horror.interaction.denied')).toBe(token ? 0 : 1);
    }
  });

  it('keeps every required clue readable without audio and allows replay without duplicating evidence', async () => {
    const run = await focused(
      (world) => {
        position(world, 'player', 9, 17);
        named(world, 'player').get(LookState).yawDeg = -90;
      },
      'press Interact @0\npress Interact @100',
      102,
    );
    const status = named(run.world, 'player').get(HorrorStatus);
    expect(status.subtitle).toContain('MEDICAL / ARCHIVE');
    expect(status.subtitle).toContain('rescue disconnect');
    expect(mission(run.world).evidence).toBe(1);
    expect(count(run, 'horror.maintenance.read')).toBe(1);
    expect(count(run, 'horror.recording.replayed')).toBe(1);
  });

  it('refuses unsafe coolant isolation but leaves the return line recoverable', async () => {
    const run = await focused(
      (world) => {
        position(world, 'player', 3, 22);
        named(world, 'player').get(LookState).yawDeg = 0;
        mission(world).recorder = true;
      },
      'press Interact @0\npress Select @5\nhold Interact 10..160',
      161,
    );
    expect(count(run, 'horror.interaction.denied')).toBe(1);
    expect(count(run, 'horror.coolant.isolated')).toBe(1);
  });

  it('the wrong rescue authority summons a spatial search, not damage, and can be corrected', async () => {
    const run = await focused(
      (world) => {
        position(world, 'player', 6, 38);
        mission(world).coolant = true;
        open(world, 'O');
      },
      'press Interact @0\npress Select @5\nhold Interact 10..130',
      131,
    );
    expect(count(run, 'horror.rescue.called')).toBe(1);
    expect(count(run, 'horror.uplink.transmitted')).toBe(1);
    expect(named(run.world, 'responder').get(HorrorThreat).targetZ).toBe(39.45);
    expect(named(run.world, 'player').get(Health).current).toBe(100);
  });

  it('death and completed extraction both prevent further movement, interactions and flashlight edges', async () => {
    for (const ended of ['dead', 'escaped'] as const) {
      const run = await focused(
        (world) => {
          position(world, 'player', 3, 10);
          mission(world)[ended] = true;
        },
        'axis Forward 1 0..120\nhold Interact 0..120\nhold Crouch 0..120\nhold Sprint 0..120\npress Flashlight @1',
        120,
      );
      expect(named(run.world, 'player').get(Transform).position).toEqual({ x: 3, y: 0, z: 10 });
      expect(count(run, 'horror.fuse.taken')).toBe(0);
      expect(count(run, 'horror.flashlight.changed')).toBe(0);
      expect(named(run.world, 'player').get(HorrorPlayer).crouched).toBe(false);
      expect(named(run.world, 'player').get(HorrorPlayer).stamina).toBe(6);
    }
  });
});

describe('readable, physical threat and quiet movement', () => {
  it('the catch warning cooldown expires while the responder searches out of sight', async () => {
    const run = await focused(
      (world) => {
        mission(world).power = true;
        position(world, 'player', 15, 3);
        position(world, 'responder', 20, 22);
        Object.assign(named(world, 'responder').get(HorrorThreat), {
          mode: 'search',
          searchTicks: 300,
          targetX: 20,
          targetZ: 22,
          warningCooldown: 120,
        });
      },
      '',
      90,
    );
    expect(named(run.world, 'responder').get(HorrorThreat).warningCooldown).toBe(30);
    expect(count(run, 'horror.threat.chase')).toBe(0);
  });
  it('walls block sight, while removing the same wall gives a positive visibility control', async () => {
    const run = await focused(() => {}, '', 0);
    const grid = run.world.getResource(FPS_COLLISION);
    if (grid === undefined) throw new Error('Missing collision grid');
    const from = { x: 10, y: 1.6, z: 18 };
    const to = { x: 15, y: 1.6, z: 18 };
    expect(clearSight(grid, from, to)).toBe(false);
    const cell = grid.cells[(40 - 18) * 31 + 12];
    if (cell === undefined) throw new Error('Missing measured wall');
    cell.solid = false;
    expect(clearSight(grid, from, to)).toBe(true);
  });

  it('crouching in darkness prevents the detection that standing in light produces', async () => {
    const setup = (world: World) => {
      mission(world).power = true;
      open(world, 'PA');
      position(world, 'player', 20, 22);
      position(world, 'responder', 25, 22);
      Object.assign(named(world, 'responder').get(HorrorThreat), {
        mode: 'search',
        targetX: 25,
        targetZ: 22,
        searchTicks: 1000,
        facingX: -1,
        facingZ: 0,
      });
    };
    const loud = await focused(setup, '', 90);
    const quiet = await focused(setup, 'press Flashlight @0\nhold Crouch 0..90', 90);
    expect(count(loud, 'horror.threat.chase')).toBe(1);
    expect(count(quiet, 'horror.threat.chase')).toBe(0);
    expect(named(quiet.world, 'responder').get(HorrorThreat).suspicion).toBe(0);
  });

  it('running is audible around an open corner; the same crouched motion is not', async () => {
    const setup = (world: World) => {
      mission(world).power = true;
      open(world, 'PA');
      position(world, 'player', 20, 23);
      position(world, 'responder', 24, 22);
      Object.assign(named(world, 'responder').get(HorrorThreat), {
        mode: 'patrol',
        facingX: 1,
        facingZ: 0,
      });
    };
    const sprint = await focused(
      setup,
      'press Flashlight @0\naxis Forward 1 0..10\nhold Sprint 0..10',
      10,
    );
    const sneak = await focused(
      setup,
      'press Flashlight @0\naxis Forward 1 0..10\nhold Crouch 0..10',
      10,
    );
    expect(count(sprint, 'horror.threat.search')).toBe(1);
    expect(count(sneak, 'horror.threat.search')).toBe(0);
    expect(named(sprint.world, 'player').get(HorrorPlayer).noise).toBe(12);
    expect(named(sneak.world, 'player').get(HorrorPlayer).noise).toBe(1.2);
  });

  it('escapes an actual chase through the maintenance loop without teleporting or killing the threat', async () => {
    let last: { x: number; z: number } | undefined;
    let largestStep = 0;
    const run = await runScene(SCENE, {
      plugin: fixture((world) => {
        mission(world).power = true;
        open(world, 'PA');
        position(world, 'player', 20, 22);
        position(world, 'responder', 25, 22);
        Object.assign(named(world, 'responder').get(HorrorThreat), {
          mode: 'search',
          searchTicks: 2000,
          targetX: 20,
          targetZ: 22,
          facingX: -1,
          facingZ: 0,
        });
      }),
      ticks: 1500,
      captureHistory: false,
      captureTickHashes: false,
      input: `
        press Flashlight @1
        hold Sprint 60..376
        aim -90 0 @60
        axis Forward 1 60..218
        aim 180 0 @218
        axis Forward 1 218..376
        aim -90 0 @376
        axis Forward 1 376..586
        aim 0 0 @586
        axis Forward 1 586..766
        hold Crouch 767..1500
      `,
      invariants: [
        {
          name: 'movement never teleports and visitor remains alive during evasion',
          check(world) {
            const player = named(world, 'player');
            const pos = player.get(Transform).position;
            if (last !== undefined)
              largestStep = Math.max(
                largestStep,
                Math.abs(pos.x - last.x),
                Math.abs(pos.z - last.z),
              );
            last = { x: pos.x, z: pos.z };
            return largestStep < 0.064 && player.get(Health).current === 100;
          },
        },
      ],
    });
    const transitions = run.events
      .history()
      .filter((event) =>
        ['horror.threat.chase', 'horror.threat.search', 'horror.threat.evaded'].includes(
          event.type,
        ),
      );
    expect(transitions.map((event) => [event.type, event.tick])).toEqual([
      ['horror.threat.chase', 33],
      ['horror.threat.search', 367],
      ['horror.threat.evaded', 734],
    ]);
    expect(largestStep).toBeGreaterThan(0.06);
    expect(named(run.world, 'responder').get(HorrorThreat).mode).toBe('patrol');
    expect(named(run.world, 'player').get(Transform).position.x).toBeCloseTo(2.993333, 5);
    expect(count(run, 'player.died')).toBe(0);
    expect(count(run, 'weapon.fired')).toBe(0);
  });

  it('cannot sprint diagonally faster than straight, and exhaustion has a real recovery threshold', async () => {
    const run = await focused(
      (world) => position(world, 'player', 15, 3),
      'hold Sprint 0..600\naxis Forward 1 0..600\naxis Strafe 1 0..600',
      600,
    );
    const player = named(run.world, 'player').get(HorrorPlayer);
    expect(player.stamina).toBeLessThan(2);
    expect(count(run, 'horror.player.step')).toBeGreaterThan(0);
    const straight = await focused(() => {}, 'axis Forward 1 0..10\nhold Sprint 0..10', 10);
    const diagonal = await focused(
      () => {},
      'axis Forward 1 0..10\naxis Strafe 1 0..10\nhold Sprint 0..10',
      10,
    );
    const s = named(straight.world, 'player').get(Transform).position;
    const d = named(diagonal.world, 'player').get(Transform).position;
    expect((d.x - 15) ** 2 + (d.z - 3) ** 2).toBeCloseTo((s.z - 3) ** 2, 10);
  });

  it('small repeated runs have byte-identical full trajectories', async () => {
    const a = await runScene(SCENE, {
      plugin: nullMeridianPlugin,
      ticks: 120,
      input: 'axis Forward 1 0..60',
    });
    const b = await runScene(SCENE, {
      plugin: nullMeridianPlugin,
      ticks: 120,
      input: 'axis Forward 1 0..60',
    });
    expect(a.hash).toBe(b.hash);
    expect(hashString(a.tickHashes.join('|'))).toBe(hashString(b.tickHashes.join('|')));
  });
});
