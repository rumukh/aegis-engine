import { describe, it, expect } from 'vitest';
import { ContentCode, Sprite, Model, Light, createRegistry, parseScene } from './index.js';

describe('@aegis/content public surface', () => {
  it('defines stable, unique diagnostic codes', () => {
    const codes = Object.values(ContentCode);
    expect(new Set(codes).size).toBe(codes.length);
    expect(ContentCode.UnknownComponent).toMatch(/^AEG-CONTENT-\d{4}$/);
  });

  it('registers visual appearance components with stable ids', () => {
    expect(Sprite.id).toBe('Sprite');
    expect(Model.id).toBe('Model');
    expect(Light.id).toBe('Light');
  });

  it('produces sensible visual defaults', () => {
    expect(Sprite.create().visible).toBe(true);
    expect(Light.create().kind).toBe('point');
  });

  it('exposes the loader and registry factories', () => {
    expect(typeof createRegistry).toBe('function');
    expect(typeof parseScene).toBe('function');
  });
});
