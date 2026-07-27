/**
 * The capture gate's judgement, tested without a browser.
 *
 * `captureAll` needs Chrome, a dev server and three real playthroughs, which is why the rule it
 * enforces went unexamined long enough for a silent fallback to live in it. {@link judgeRun} is
 * that rule with the I/O removed, so every branch of it is reachable from a plain unit test.
 *
 * The `photoEvent` fallback was found by mutation, not by reading: pointing Sector Breach at
 * `enemy.never.damaged` moved its captured frame from tick 177 to tick 241 and the run still
 * printed `OK` and exited 0. These tests exist so that cannot come back quietly.
 */

import { describe, expect, it } from 'vitest';

import { judgeRun } from './capture.js';
import type { GameAcceptance } from './catalog.js';
import type { EventLine } from './protocol.js';

const LOG: readonly EventLine[] = [
  { type: 'session.started', tick: 0 },
  { type: 'enemy.damaged', tick: 177 },
  { type: 'enemy.damaged', tick: 190 },
  { type: 'mission.completed', tick: 241 },
];

const BASE: GameAcceptance = { winEvent: 'mission.completed', playerName: 'operative' };

describe('judgeRun', () => {
  it('passes a run that emitted its win event with the player alive', () => {
    const verdict = judgeRun(LOG, [], BASE);
    expect(verdict.failures).toEqual([]);
    expect(verdict.won).toBe(true);
    expect(verdict.photoTick).toBe(241);
  });

  it('fails a run whose win event never fired', () => {
    const verdict = judgeRun(
      LOG.filter((event) => event.type !== 'mission.completed'),
      [],
      BASE,
    );
    expect(verdict.won).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain('mission.completed');
    expect(verdict.photoTick).toBeUndefined();
  });

  it('fails a run that ends with the player dead, even though it was won', () => {
    const verdict = judgeRun(LOG, ['operative'], BASE);
    expect(verdict.won).toBe(true);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain('ended the run dead');
  });

  it('reports both failures at once rather than stopping at the first', () => {
    const verdict = judgeRun([{ type: 'session.started', tick: 0 }], ['operative'], BASE);
    expect(verdict.failures).toHaveLength(2);
  });

  it('says nothing about acceptance when a game declares none', () => {
    const verdict = judgeRun(LOG, ['operative'], undefined);
    expect(verdict).toEqual({ won: false, failures: [] });
  });

  describe('photoEvent', () => {
    it('photographs the named event when the run emitted it', () => {
      const verdict = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.damaged' });
      expect(verdict.failures).toEqual([]);
      expect(verdict.photoTick).toBe(177);
    });

    it('takes the first occurrence, so the tick is a property of the run and not of the name', () => {
      // 190 is also an `enemy.damaged`. Picking the first keeps the choice deterministic.
      const verdict = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.damaged' });
      expect(verdict.photoTick).toBe(177);
    });

    it('photographs the win tick when no photoEvent is named', () => {
      expect(judgeRun(LOG, [], BASE).photoTick).toBe(241);
    });

    it('fails, rather than falling back, when a named photoEvent never fired', () => {
      const verdict = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.never.damaged' });
      expect(verdict.failures).toHaveLength(1);
      expect(verdict.failures[0]).toContain('enemy.never.damaged');
      expect(verdict.failures[0]).toContain('never emitted');
    });

    it('still reports the win, so a bad photo name cannot make a won run look lost', () => {
      // The ruling that kept `photoEvent` rests on this: the name is not on any path to `won`.
      // If that ever stops being true, this test is the one that says so.
      const verdict = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.never.damaged' });
      expect(verdict.won).toBe(true);
    });

    it('cannot make a lost run look won either', () => {
      const lost = LOG.filter((event) => event.type !== 'mission.completed');
      const verdict = judgeRun(lost, [], { ...BASE, photoEvent: 'enemy.damaged' });
      expect(verdict.won).toBe(false);
      expect(verdict.failures).toHaveLength(1);
    });
  });

  describe('the guard can actually fail', () => {
    // Without these, every assertion above would still pass if `judgeRun` were replaced by a
    // function that returns `{ won: true, failures: [] }` for a win and nothing else — the
    // photoEvent branch would simply never be entered. Each case here proves the *absence* of a
    // failure in the tests above is a measurement rather than a gap.

    it('the named-but-absent case really does differ from the named-and-present case', () => {
      const present = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.damaged' });
      const absent = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.damaged.typo' });
      expect(present.failures).toEqual([]);
      expect(absent.failures).not.toEqual([]);
      expect(present.photoTick).not.toBe(absent.photoTick);
    });

    it('the old behaviour — falling back to the win tick — is now impossible to observe', () => {
      // This is exactly what the mutation produced before the fix: photoTick === the win tick,
      // failures empty. If someone reinstates `?? win`, this is the assertion that reddens.
      const verdict = judgeRun(LOG, [], { ...BASE, photoEvent: 'enemy.never.damaged' });
      const fellBackSilently = verdict.photoTick === 241 && verdict.failures.length === 0;
      expect(fellBackSilently).toBe(false);
    });
  });
});
