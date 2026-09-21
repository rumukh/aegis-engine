import { BrowserServiceError, requireId } from '../errors.js';

export interface LogicalSize {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Hotspot {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  labelKey: string;
}

/** The element must use object-fit:contain (or equivalent centered SVG meet behavior). */
export function logicalPoint(
  client: Point,
  bounds: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>,
  logical: LogicalSize,
): Point | undefined {
  if (
    ![
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
      client.x,
      client.y,
      logical.width,
      logical.height,
    ].every(Number.isFinite) ||
    logical.width <= 0 ||
    logical.height <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    throw new BrowserServiceError(
      'invalid-data',
      'Logical coordinate bounds must be finite and positive.',
    );
  const scale = Math.min(bounds.width / logical.width, bounds.height / logical.height);
  const x = (client.x - bounds.left - (bounds.width - logical.width * scale) / 2) / scale;
  const y = (client.y - bounds.top - (bounds.height - logical.height * scale) / 2) / scale;
  return x < 0 || y < 0 || x >= logical.width || y >= logical.height ? undefined : { x, y };
}

export function hitHotspot(
  point: Point | undefined,
  hotspots: readonly Hotspot[],
): string | undefined {
  if (!point) return undefined;
  return hotspots.find(
    (h) => point.x >= h.x && point.x < h.x + h.width && point.y >= h.y && point.y < h.y + h.height,
  )?.id;
}

export function validateHotspots(hotspots: readonly Hotspot[], size: LogicalSize): void {
  const ids = new Set<string>();
  for (const item of hotspots) {
    requireId(item.id);
    if (
      ids.has(item.id) ||
      ![item.x, item.y, item.width, item.height].every(Number.isFinite) ||
      item.x < 0 ||
      item.y < 0 ||
      item.width <= 0 ||
      item.height <= 0 ||
      item.x + item.width > size.width ||
      item.y + item.height > size.height
    )
      throw new BrowserServiceError(
        'invalid-data',
        'Hotspot is duplicate, invalid or outside the logical scene.',
      );
    ids.add(item.id);
  }
}

/** Adjacency is authored IDs, never DOM position or responsive CSS order. */
export function slotNeighbors(
  id: string,
  adjacency: Readonly<Record<string, readonly string[]>>,
): readonly string[] {
  requireId(id);
  if (!Object.hasOwn(adjacency, id))
    throw new BrowserServiceError('invalid-data', 'Unknown logical slot.');
  const neighbors = adjacency[id]!;
  if (
    new Set(neighbors).size !== neighbors.length ||
    neighbors.some((next) => next === id || !Object.hasOwn(adjacency, next))
  )
    throw new BrowserServiceError('invalid-data', 'Invalid logical slot adjacency.');
  return [...neighbors];
}
