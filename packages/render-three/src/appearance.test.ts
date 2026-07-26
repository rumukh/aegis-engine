/**
 * Appearance resolution: the authored `Sprite`/`Model` components win, the role palette is the
 * fallback, and both are pure functions of world data.
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, MeshLambertMaterial } from 'three';
import {
  MODE_BACKGROUNDS,
  ROLE_COLORS,
  flatMaterial,
  litMaterial,
  resolveAppearance,
} from './appearance.js';
import { Primitives } from './primitives.js';

describe('appearance', () => {
  it('falls back to the role palette when nothing is authored', () => {
    expect(resolveAppearance({ role: 'player' })).toEqual({
      color: ROLE_COLORS.player,
      visible: true,
      opacity: 1,
    });
  });

  it('honours an authored Sprite tint over the palette', () => {
    const appearance = resolveAppearance({
      role: 'enemy',
      sprite: { texture: 'grunt', tint: '#123456' },
    });
    expect(appearance.color).toBe('#123456');
    expect(appearance.opacity).toBe(1);
  });

  it('reads alpha out of an eight-digit tint', () => {
    const appearance = resolveAppearance({
      role: 'goal',
      sprite: { texture: 'goal', tint: '#00ff0080' },
    });
    expect(appearance.color).toBe('#00ff00');
    expect(appearance.opacity).toBeCloseTo(128 / 255, 2);
  });

  it('respects the visible flag of either appearance component', () => {
    expect(
      resolveAppearance({ role: 'player', sprite: { texture: '', visible: false } }).visible,
    ).toBe(false);
    expect(resolveAppearance({ role: 'enemy', model: { mesh: '', visible: false } }).visible).toBe(
      false,
    );
    expect(resolveAppearance({ role: 'enemy', model: { mesh: '' } }).visible).toBe(true);
  });

  it('ignores a malformed tint rather than drawing nothing', () => {
    expect(
      resolveAppearance({ role: 'wall', sprite: { texture: '', tint: 'rebeccapurple' } }).color,
    ).toBe(ROLE_COLORS.wall);
  });

  it('is a pure function of its input', () => {
    const input = { role: 'door' as const, opacity: 0.5 };
    expect(resolveAppearance(input)).toEqual(resolveAppearance(input));
  });

  it('gives every mode a background', () => {
    for (const mode of ['platformer', 'iso', 'fps'] as const) {
      expect(MODE_BACKGROUNDS[mode]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('builds transparent materials only when the appearance asks for it', () => {
    const opaque = litMaterial(resolveAppearance({ role: 'wall' })) as MeshLambertMaterial;
    expect(opaque.transparent).toBe(false);
    const ghost = flatMaterial(resolveAppearance({ role: 'goal', opacity: 0.3 }));
    expect(ghost.transparent).toBe(true);
    expect(ghost.opacity).toBeCloseTo(0.3);
    opaque.dispose();
    ghost.dispose();
  });
});

describe('primitives', () => {
  it('shares one material per appearance and shading', () => {
    const primitives = new Primitives();
    const a = primitives.roleMaterial('wall');
    const b = primitives.roleMaterial('wall');
    const c = primitives.roleMaterial('wall', 'flat');
    const d = primitives.roleMaterial('hazard');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toBeInstanceOf(MeshLambertMaterial);
    expect(c).toBeInstanceOf(MeshBasicMaterial);
    primitives.dispose();
  });

  it('shares one geometry across every box it makes', () => {
    const primitives = new Primitives();
    const first = primitives.boxMesh(resolveAppearance({ role: 'wall' }));
    const second = primitives.boxMesh(resolveAppearance({ role: 'floor' }));
    expect(first.geometry).toBe(second.geometry);
    expect(primitives.planeMesh(resolveAppearance({ role: 'goal' })).geometry).toBe(
      primitives.plane,
    );
    primitives.dispose();
  });
});
