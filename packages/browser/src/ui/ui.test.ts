import { describe, expect, it } from 'vitest';
import { logicalPoint, slotNeighbors } from './coordinates.js';
import { createPlacement } from './placement.js';
import { projectPresentation } from './projection.js';
import { choicePage, createMessages, isPresentationPreferences } from './preferences.js';

describe('framework-neutral interaction rules', () => {
  it('maps fresh viewport rects including letterbox and scroll, rejecting margins', () => {
    expect(
      logicalPoint(
        { x: 110, y: 220 },
        { left: 10, top: 20, width: 200, height: 400 },
        { width: 100, height: 100 },
      ),
    ).toEqual({ x: 50, y: 50 });
    expect(
      logicalPoint(
        { x: 110, y: 30 },
        { left: 10, top: 20, width: 200, height: 400 },
        { width: 100, height: 100 },
      ),
    ).toBeUndefined();
    expect(
      logicalPoint(
        { x: 250, y: 0 },
        { left: 50, top: -100, width: 400, height: 200 },
        { width: 100, height: 100 },
      ),
    ).toEqual({ x: 50, y: 50 });
  });
  it('keeps adjacency data-defined and rejects non-slots', () => {
    expect(slotNeighbors('b', { c: ['b'], b: ['a', 'c'], a: ['b'] })).toEqual(['a', 'c']);
    expect(() => slotNeighbors('b', { b: ['missing'] })).toThrow();
  });
  it('previews without mutation, rejects full slots and prevents concurrent double commits', async () => {
    const commands: string[] = [];
    const messages: (string | undefined)[] = [];
    let finish!: () => void;
    const placement = createPlacement({
      validate: (_item, slot) =>
        slot === 'full' ? { ok: false, messageKey: 'slot.full' } : { ok: true },
      commit: (item, slot) => {
        commands.push(`${item}:${slot}`);
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      onChange: (state) => messages.push(state.messageKey),
      onError: (cause) => {
        throw cause;
      },
    });
    placement.select('jar');
    expect(placement.preview('free')).toEqual({ ok: true });
    expect(commands).toEqual([]);
    expect(await placement.place('full')).toBe(false);
    expect(messages).toContain('slot.full');
    const first = placement.place('free');
    expect(await placement.place('free')).toBe(false);
    placement.cancel();
    finish();
    expect(await first).toBe(true);
    expect(commands).toEqual(['jar:free']);
    expect(placement.selected()).toBeUndefined();
  });
  it('physically omits private and spoiler content from every projected field', () => {
    const entries = [
      {
        id: 'secret',
        playerIds: ['p1'],
        content: {
          label: 'secret-name',
          caption: 'secret-caption',
          narration: { packId: 'private', lineId: 'secret' },
        },
      },
      {
        id: 'ending',
        spoiler: true,
        content: { label: 'hidden-ending' },
        safeAlternative: { label: 'safe-warning' },
      },
    ];
    expect(projectPresentation(entries, { handoff: true })).toEqual([]);
    const safe = projectPresentation(entries, { playerId: 'p2', hideSpoilers: true });
    expect(safe).toEqual([{ id: 'ending', content: { label: 'safe-warning' } }]);
    expect(JSON.stringify(safe)).not.toMatch(/secret|hidden-ending/);
    expect(projectPresentation(entries, { playerId: 'p1' })).toHaveLength(2);
  });
  it('preserves Cyrillic authored strings and has no English fallback or unbounded choice group', () => {
    const message = createMessages({ hello: 'Ёж и ёлка: {name}' });
    expect(message('hello', { name: 'Алёна' })).toBe('Ёж и ёлка: Алёна');
    expect(() => message('missing')).toThrow(/Missing localized/);
    expect(() => message('hello')).toThrow(/parameter/);
    expect(choicePage([1, 2, 3, 4, 5], 1)).toEqual({ items: [4, 5], page: 1, pages: 2 });
    expect(
      isPresentationPreferences({
        locale: 'ru',
        textScale: 2,
        reducedMotion: true,
        comfort: true,
        hideSpoilers: false,
        volumes: { music: 0, effects: 1, narration: 1 },
      }),
    ).toBe(true);
  });
});
