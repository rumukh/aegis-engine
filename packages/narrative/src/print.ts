import { check, id, integer, list, member, record, reference, text, unique } from './validation.js';

export type PrintKind = 'card' | 'token' | 'map' | 'notebook' | 'rules';
export interface PrintItem {
  id: string;
  contentId: string;
  kind: PrintKind;
  front: string[];
  back: string[] | null;
}
export interface PrintDocument {
  title: string;
  items: PrintItem[];
}
export interface PrintOptions {
  paper: 'A4' | 'Letter';
  columns: number;
  rows: number;
  marginMm: number;
  gutterMm: number;
  fontPt: number;
  duplex: 'none' | 'long-edge' | 'short-edge';
}
export interface PrintLayout {
  schema: 1;
  title: string;
  paper: 'A4' | 'Letter';
  widthMm: number;
  heightMm: number;
  fontPt: number;
  duplex: 'none' | 'long-edge' | 'short-edge';
  guidance: string;
  pages: {
    side: 'front' | 'back';
    items: {
      id: string;
      contentId: string;
      kind: PrintKind;
      xMm: number;
      yMm: number;
      widthMm: number;
      heightMm: number;
      lines: string[];
    }[];
  }[];
}

function boundedMm(value: unknown, path: string, min: number, max: number): number {
  check(
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    'PRINT-BOUND',
    path,
    `Expected a finite measurement in ${min}..${max}.`,
    'Choose a valid physical page measurement.',
  );
  return value;
}

function wrap(lines: readonly string[], columns: number, maxLines: number, path: string): string[] {
  const result: string[] = [];
  for (const paragraph of lines) {
    let line = '';
    for (const word of paragraph.split(/\s+/u)) {
      check(
        [...word].length <= columns,
        'PRINT-OVERFLOW',
        path,
        'An unbreakable word exceeds the text area.',
        'Shorten the label or use a larger cell.',
      );
      const candidate = line ? `${line} ${word}` : word;
      if ([...candidate].length > columns) {
        result.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) result.push(line);
  }
  check(
    result.length <= maxLines,
    'PRINT-OVERFLOW',
    path,
    `Text needs ${result.length} lines; cell holds ${maxLines}.`,
    'Shorten text, reduce rows/columns, or author an additional page. Content is never clipped silently.',
  );
  return result;
}

export function layoutPrint(
  input: PrintDocument,
  options: PrintOptions,
  approvedContentIds: readonly string[],
): PrintLayout {
  const o = record(input, '$');
  const paper = member(options.paper, ['A4', 'Letter'], '$.options.paper');
  const columns = integer(options.columns, '$.options.columns', 1, 8),
    rows = integer(options.rows, '$.options.rows', 1, 12);
  const margin = boundedMm(options.marginMm, '$.options.marginMm', 5, 40),
    gutter = boundedMm(options.gutterMm, '$.options.gutterMm', 0, 20);
  const fontPt = boundedMm(options.fontPt, '$.options.fontPt', 10, 32),
    duplex = member(options.duplex, ['none', 'long-edge', 'short-edge'], '$.options.duplex');
  const widthMm = paper === 'A4' ? 210 : 215.9,
    heightMm = paper === 'A4' ? 297 : 279.4;
  const width = (widthMm - 2 * margin - (columns - 1) * gutter) / columns;
  const height = (heightMm - 2 * margin - (rows - 1) * gutter) / rows;
  check(
    width > 12 && height > 12,
    'PRINT-BOUND',
    '$.options',
    'Grid leaves no readable cell area.',
    'Reduce margins, rows or columns.',
  );
  const chars = Math.floor((width - 8) / (fontPt * 0.352778));
  const lines = Math.floor((height - 8) / (fontPt * 0.352778 * 1.4));
  check(
    chars > 0 && lines > 0,
    'PRINT-BOUND',
    '$.options',
    'Font does not fit the grid.',
    'Use larger cells.',
  );
  const items = list(
    o.items,
    '$.items',
    (value, path): PrintItem => {
      const item = record(value, path),
        contentId = id(item.contentId, `${path}.contentId`);
      reference(contentId, approvedContentIds, `${path}.contentId`);
      const front = list(item.front, `${path}.front`, text, 256);
      check(
        front.length > 0,
        'PRINT-CONTENT',
        path,
        'Printable item has no front content.',
        'Supply approved text.',
      );
      const back = item.back === null ? null : list(item.back, `${path}.back`, text, 256);
      check(
        back === null || (duplex !== 'none' && back.length > 0),
        'PRINT-DUPLEX',
        path,
        'Back content requires a duplex layout.',
        'Choose long-edge/short-edge duplex or remove back content.',
      );
      return {
        id: id(item.id, `${path}.id`),
        contentId,
        kind: member(item.kind, ['card', 'token', 'map', 'notebook', 'rules'], `${path}.kind`),
        front,
        back,
      };
    },
    1024,
  );
  check(
    items.length > 0,
    'PRINT-CONTENT',
    '$.items',
    'No printable items.',
    'Supply approved content.',
  );
  unique(
    items.map((item) => item.id),
    '$.items',
  );
  const pages: PrintLayout['pages'] = [];
  const pageSize = columns * rows;
  for (let start = 0; start < items.length; start += pageSize) {
    const chunk = items.slice(start, start + pageSize);
    for (const side of duplex === 'none' ? (['front'] as const) : (['front', 'back'] as const)) {
      pages.push({
        side,
        items: chunk.map((item, index) => {
          const col = index % columns,
            row = Math.floor(index / columns);
          const x = side === 'back' && duplex === 'long-edge' ? columns - 1 - col : col;
          const y = side === 'back' && duplex === 'short-edge' ? rows - 1 - row : row;
          return {
            id: item.id,
            contentId: item.contentId,
            kind: item.kind,
            xMm: margin + x * (width + gutter),
            yMm: margin + y * (height + gutter),
            widthMm: width,
            heightMm: height,
            lines: wrap(
              side === 'front' ? item.front : (item.back ?? []),
              chars,
              lines,
              `items.${item.id}.${side}`,
            ),
          };
        }),
      });
    }
  }
  return {
    schema: 1,
    title: text(o.title, '$.title'),
    paper,
    widthMm,
    heightMm,
    fontPt,
    duplex,
    guidance:
      duplex === 'none'
        ? 'Print at 100% / actual size; disable browser headers and footers. Check one page before printing all.'
        : `Portrait ${duplex} duplex; paired pages are front then back. Back cell positions are mirrored across the ${duplex === 'long-edge' ? 'vertical' : 'horizontal'} axis. Print at 100% with headers/footers disabled. Test one sheet for printer feed orientation and registration before cutting.`,
    pages,
  };
}

export function escapePrintText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders only validated layout geometry; raw HTML, CSS, URLs and scripts are never accepted. */
export function renderPrintHtml(input: PrintLayout): string {
  const o = record(input, '$');
  check(
    o.schema === 1,
    'VERSION',
    '$.schema',
    'Unsupported print layout.',
    'Use layoutPrint first.',
  );
  const paper = member(o.paper, ['A4', 'Letter'], '$.paper');
  const width = paper === 'A4' ? 210 : 215.9,
    height = paper === 'A4' ? 297 : 279.4;
  check(
    o.widthMm === width && o.heightMm === height,
    'PRINT-BOUND',
    '$',
    'Page geometry differs from the selected paper.',
    'Use unmodified layoutPrint output.',
  );
  const font = boundedMm(o.fontPt, '$.fontPt', 10, 32);
  const title = escapePrintText(text(o.title, '$.title')),
    guidance = escapePrintText(text(o.guidance, '$.guidance'));
  const pages = list(
    o.pages,
    '$.pages',
    (value, path) => {
      const page = record(value, path);
      member(page.side, ['front', 'back'], `${path}.side`);
      const items = list(
        page.items,
        `${path}.items`,
        (v, p) => {
          const item = record(v, p);
          const x = boundedMm(item.xMm, `${p}.xMm`, 0, width),
            y = boundedMm(item.yMm, `${p}.yMm`, 0, height);
          const w = boundedMm(item.widthMm, `${p}.widthMm`, 1, width),
            h = boundedMm(item.heightMm, `${p}.heightMm`, 1, height);
          check(
            x + w <= width + 0.000001 && y + h <= height + 0.000001,
            'PRINT-OVERFLOW',
            p,
            'Item lies outside the page.',
            'Use valid layoutPrint geometry.',
          );
          const lines = list(
            item.lines,
            `${p}.lines`,
            (line, at) => (typeof line === 'string' && line.length === 0 ? '' : text(line, at)),
            256,
          );
          check(
            lines.length <= Math.floor((h - 8) / (font * 0.352778 * 1.4)) &&
              lines.every((line) => [...line].length <= Math.floor((w - 8) / (font * 0.352778))),
            'PRINT-OVERFLOW',
            p,
            'Altered text exceeds the cell.',
            'Regenerate the layout with the new text.',
          );
          return `<section class="item" data-content-id="${escapePrintText(id(item.contentId, `${p}.contentId`))}" style="left:${x}mm;top:${y}mm;width:${w}mm;height:${h}mm">${lines.map(escapePrintText).join('\n')}</section>`;
        },
        96,
      );
      return `<article class="page">${items.join('')}</article>`;
    },
    2048,
  );
  check(
    pages.length > 0,
    'PRINT-CONTENT',
    '$.pages',
    'Print layout has no pages.',
    'Use a nonempty approved document.',
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>@page{size:${width}mm ${height}mm;margin:0}*{box-sizing:border-box}body{margin:0;font-family:monospace;font-size:${font}pt;line-height:1.4}.page{position:relative;width:${width}mm;height:${height}mm;break-after:page}.page:last-child{break-after:auto}.item{position:absolute;border:.2mm solid black;padding:4mm;white-space:pre;overflow:visible}@media print{.guidance{display:none}}</style></head><body><aside class="guidance">${guidance}</aside>${pages.join('')}</body></html>`;
}
