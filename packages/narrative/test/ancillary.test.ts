import { describe, expect, it } from 'vitest';
import {
  createCosmeticState,
  equipCosmetic,
  escapePrintText,
  grantCosmetic,
  layoutPrint,
  renderPrintHtml,
  restoreCosmetics,
  validateCosmetics,
} from '../src/index.js';
import type { PrintDocument, PrintOptions } from '../src/index.js';

describe('shared idempotent cosmetic helpers', () => {
  const catalog = [
    { id: 'star', slot: 'badge', assetId: 'star-svg' },
    { id: 'leaf', slot: 'badge', assetId: 'leaf-svg' },
  ];

  it('shares one grant mechanism across story and minigame result claims', () => {
    const empty = createCosmeticState();
    const story = grantCosmetic(catalog, empty, 'story-star', 'star');
    const puzzle = grantCosmetic(catalog, story, 'puzzle-run:complete', 'leaf');
    expect(puzzle.owned).toEqual(['star', 'leaf']);
    expect(grantCosmetic(catalog, puzzle, 'puzzle-run:complete', 'leaf')).toEqual(puzzle);
    expect(grantCosmetic(catalog, puzzle, 'another-star', 'star').owned).toEqual(['star', 'leaf']);
    const equipped = equipCosmetic(catalog, equipCosmetic(catalog, puzzle, 'star'), 'leaf');
    expect(equipped.equipped).toEqual([{ slot: 'badge', item: 'leaf' }]);
    expect(restoreCosmetics(catalog, JSON.parse(JSON.stringify(equipped)))).toEqual(equipped);
    expect(empty.owned).toEqual([]);
    const longResultId = `${'a'.repeat(128)}:complete`;
    expect(grantCosmetic(catalog, empty, longResultId, 'star').claims[0]?.id).toBe(longResultId);
    expect(grantCosmetic(catalog, empty, '["family","p1","ability"]', 'star').owned).toEqual([
      'star',
    ]);
  });

  it('rejects conflicting claim identity, unknown assets/items and unearned equipment', () => {
    const state = grantCosmetic(catalog, createCosmeticState(), 'grant', 'star');
    expect(() => grantCosmetic(catalog, state, 'grant', 'leaf')).toThrow(/reused/);
    expect(() => grantCosmetic(catalog, state, 'missing', 'absent')).toThrow(/Unknown reference/);
    expect(() => equipCosmetic(catalog, state, 'leaf')).toThrow(/not owned/);
    expect(() => validateCosmetics(catalog, ['star-svg'])).toThrow(/Unknown reference/);
    expect(() => restoreCosmetics(catalog, { ...state, owned: ['star', 'leaf'] })).toThrow(
      /lacks a grant/,
    );
    expect(() =>
      restoreCosmetics(catalog, { ...state, equipped: [{ slot: 'hat', item: 'star' }] }),
    ).toThrow(/does not fit/);
  });
});

describe('escaped physical print layout primitives', () => {
  const document: PrintDocument = {
    title: 'Workshop sample',
    items: [
      {
        id: 'a',
        contentId: 'clue-a',
        kind: 'card',
        front: ['A ribbon reflects light.'],
        back: ['Card back.'],
      },
      { id: 'b', contentId: 'clue-b', kind: 'token', front: ['Leaf'], back: ['Token back.'] },
      { id: 'c', contentId: 'map', kind: 'map', front: ['Room to garden.'], back: null },
      {
        id: 'd',
        contentId: 'notebook',
        kind: 'notebook',
        front: ['What did you notice?'],
        back: null,
      },
      {
        id: 'e',
        contentId: 'rules',
        kind: 'rules',
        front: ['Take turns. Share a clue.'],
        back: null,
      },
    ],
  };
  const approved = ['clue-a', 'clue-b', 'map', 'notebook', 'rules'];
  const options: PrintOptions = {
    paper: 'A4',
    columns: 2,
    rows: 3,
    marginMm: 10,
    gutterMm: 4,
    fontPt: 12,
    duplex: 'long-edge',
  };

  it.each(['A4', 'Letter'] as const)(
    'lays out all five material families within %s paper',
    (paper) => {
      const layout = layoutPrint(document, { ...options, paper }, approved);
      expect(layout.pages).toHaveLength(2);
      expect(layout.widthMm).toBe(paper === 'A4' ? 210 : 215.9);
      expect(layout.heightMm).toBe(paper === 'A4' ? 297 : 279.4);
      expect(layout.pages[0]?.items.map((i) => i.kind)).toEqual([
        'card',
        'token',
        'map',
        'notebook',
        'rules',
      ]);
      for (const page of layout.pages)
        for (const item of page.items) {
          expect(item.xMm).toBeGreaterThanOrEqual(10);
          expect(item.yMm).toBeGreaterThanOrEqual(10);
          expect(item.xMm + item.widthMm).toBeLessThanOrEqual(layout.widthMm - 10 + 1e-8);
          expect(item.yMm + item.heightMm).toBeLessThanOrEqual(layout.heightMm - 10 + 1e-8);
        }
      const html = renderPrintHtml(layout);
      expect(html).toContain(`@page{size:${layout.widthMm}mm ${layout.heightMm}mm;margin:0}`);
      expect(html).toContain('data-content-id="clue-a"');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('http:');
    },
  );

  it('mirrors back positions for declared duplex edge without mirroring text', () => {
    const long = layoutPrint(document, options, approved),
      front = long.pages[0]!.items[0]!,
      back = long.pages[1]!.items[0]!;
    expect(front.xMm).toBe(10);
    expect(back.xMm).toBe(107);
    expect(back.yMm).toBe(front.yMm);
    expect(back.lines).toEqual(['Card back.']);
    const short = layoutPrint(document, { ...options, duplex: 'short-edge' }, approved);
    expect(short.pages[1]!.items[0]!.xMm).toBe(front.xMm);
    expect(short.pages[1]!.items[0]!.yMm).toBeGreaterThan(front.yMm);
    expect(short.guidance).toContain('Test one sheet');
  });

  it('paginates and keeps blank back slots aligned on incomplete sheets', () => {
    const layout = layoutPrint(document, { ...options, columns: 2, rows: 2 }, approved);
    expect(layout.pages.map((page) => page.items.length)).toEqual([4, 4, 1, 1]);
    expect(layout.pages[3]?.items[0]?.lines).toEqual([]);
    expect(layout.pages[2]?.items[0]?.contentId).toBe('rules');
  });

  it('escapes markup, rejects unknown content and fails rather than clipping text', () => {
    const hostile = {
      title: '<script>alert(1)</script>',
      items: [
        {
          id: 'a',
          contentId: 'clue-a',
          kind: 'card' as const,
          front: ['<img src=x onerror=evil()>'],
          back: null,
        },
      ],
    };
    const html = renderPrintHtml(
      layoutPrint(hostile, { ...options, columns: 1, rows: 1 }, approved),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img ');
    expect(html).toContain('&lt;img');
    expect(escapePrintText(`<&"'`)).toBe('&lt;&amp;&quot;&#39;');
    expect(() => layoutPrint(document, options, [])).toThrow(/Unknown reference/);
    expect(() => layoutPrint(document, { ...options, duplex: 'none' }, approved)).toThrow(/duplex/);
    const longText = {
      ...document,
      items: [{ ...document.items[0]!, front: ['word '.repeat(1000)] }],
    };
    expect(() => layoutPrint(longText, options, approved)).toThrow(/cell holds/);
    const layout = layoutPrint(document, options, approved);
    layout.pages[0]!.items[0]!.xMm = 1000;
    expect(() => renderPrintHtml(layout)).toThrow(/measurement/);
  });
});
