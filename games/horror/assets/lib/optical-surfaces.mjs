import { BufferGeometry, Float32BufferAttribute, RingGeometry, Vector3 } from 'three';
import { Raster } from './raster.mjs';

export const RING_INNER = (51 * 360) / 43;
export const RING_OUTER = ((51 + 41 * 0.6 + 0.49) * 360) / 43;
export const RING_ROTATION = [0.42, -0.1, -0.32];

export function ringGeometry() {
  const geometry = new RingGeometry(RING_INNER, RING_OUTER, 256, 1);
  const positions = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < positions.count; i++) {
    const radius = Math.hypot(positions.getX(i), positions.getY(i));
    uv.setXY(i, (radius - RING_INNER) / (RING_OUTER - RING_INNER), 0.5);
  }
  return geometry;
}

export function ringDensity() {
  const image = new Raster(512, 4);
  const smooth = (value) => {
    const t = Math.max(0, Math.min(1, value));
    return t * t * (3 - 2 * t);
  };
  const trough = (radius, center, width) => {
    const distance = Math.abs(radius - center) / width;
    return distance >= 1 ? 0 : (1 + Math.cos(distance * Math.PI)) / 2;
  };
  for (let x = 0; x < image.width; x++) {
    const radius = x / (image.width - 1);
    const body =
      0.4 +
      0.035 * Math.sin(radius * Math.PI * 2) -
      0.15 * trough(radius, 0.32, 0.12) -
      0.12 * trough(radius, 0.73, 0.14);
    const feather = smooth(radius / 0.065) * smooth((1 - radius) / 0.085);
    const alpha = Math.round(body * feather * 255);
    for (let y = 0; y < image.height; y++) image.pixel(x, y, [141, 134, 119, alpha]);
  }
  return image;
}

export function curvedVisor(outline) {
  const edge = outline
    .flatMap((a, i) => {
      const b = outline[(i + 1) % outline.length];
      return Array.from({ length: 8 }, (_, j) => [
        a[0] + ((b[0] - a[0]) * j) / 8,
        a[1] + ((b[1] - a[1]) * j) / 8,
      ]);
    })
    .reverse();
  const center = [0, -0.007];
  const positions = [center[0], center[1], 0.232],
    normals = [0, 0, 1],
    uvs = [0.5, 0.5],
    indices = [];
  const layers = 10;
  for (let layer = 1; layer <= layers; layer++) {
    const radius = layer / layers;
    for (const [x, y] of edge) {
      const px = center[0] + (x - center[0]) * radius;
      const py = center[1] + (y - center[1]) * radius;
      const dy = py - center[1];
      positions.push(px, py, 0.232 - 0.8 * px * px - 2 * dy * dy);
      normals.push(...new Vector3(1.6 * px, 4 * dy, 1).normalize().toArray());
      uvs.push(0.5 + (x * radius) / 0.32, 0.5 - (y * radius) / 0.22);
    }
  }
  for (let i = 0; i < edge.length; i++) {
    const next = (i + 1) % edge.length;
    indices.push(0, 1 + i, 1 + next);
    for (let layer = 1; layer < layers; layer++) {
      const a = 1 + (layer - 1) * edge.length + i;
      const b = 1 + (layer - 1) * edge.length + next;
      indices.push(a, a + edge.length, b + edge.length, a, b + edge.length, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}
