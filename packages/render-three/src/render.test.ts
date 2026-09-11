import { describe, expect, it, vi } from 'vitest';
import {
  AmbientLight,
  DataTexture,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  PointLight,
  Scene,
  SpotLight,
  Vector3,
} from 'three';
import { ForegroundScene, renderAdapter } from './render.js';

function renderer() {
  const info = {
    autoReset: true,
    memory: { geometries: 0, textures: 0 },
    programs: [],
    render: { calls: 0, triangles: 0, points: 0, lines: 0, frame: 0 },
    reset: vi.fn(() => {
      info.render.calls = 0;
      info.render.triangles = 0;
    }),
  };
  return {
    autoClear: true,
    info,
    render: vi.fn((_scene: Scene, _camera: PerspectiveCamera) => {
      info.render.calls += 3;
      info.render.triangles += 120;
    }),
    clearDepth: vi.fn(),
  };
}

describe('optional foreground render pass', () => {
  it('renders world then foreground with one depth clear and aggregated frame counters', () => {
    const gpu = renderer();
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const foreground = new ForegroundScene(camera);
    const order: string[] = [];
    gpu.render.mockImplementation((current) => {
      order.push(current === scene ? 'world' : 'foreground');
      expect(gpu.autoClear).toBe(current === scene);
      expect(gpu.info.autoReset).toBe(false);
      gpu.info.render.calls += 3;
      gpu.info.render.triangles += 120;
    });
    gpu.clearDepth.mockImplementation(() => {
      order.push('clear depth');
    });
    renderAdapter(gpu, { scene, camera, foreground });
    expect(order).toEqual(['world', 'clear depth', 'foreground']);
    expect(gpu.info.reset).toHaveBeenCalledTimes(1);
    expect(gpu.info.render.calls).toBe(6);
    expect(gpu.info.render.triangles).toBe(240);
    expect(gpu.autoClear).toBe(true);
    expect(gpu.info.autoReset).toBe(true);
  });

  it('preserves caller-managed accumulation and restores render flags when either pass throws', () => {
    const scene = new Scene(),
      camera = new PerspectiveCamera();
    const foreground = new ForegroundScene(camera);
    const gpu = renderer();
    gpu.info.autoReset = false;
    gpu.info.render.calls = 17;
    gpu.autoClear = false;
    renderAdapter(gpu, { scene, camera, foreground });
    expect(gpu.info.render.calls).toBe(23);
    expect(gpu.info.reset).not.toHaveBeenCalled();
    expect(gpu.autoClear).toBe(false);
    expect(gpu.info.autoReset).toBe(false);
    for (const failing of [scene, foreground.scene]) {
      gpu.autoClear = true;
      gpu.info.autoReset = true;
      gpu.render.mockImplementation((current) => {
        if (current === failing) throw new Error('render failed');
      });
      expect(() => renderAdapter(gpu, { scene, camera, foreground })).toThrow('render failed');
      expect(gpu.autoClear).toBe(true);
      expect(gpu.info.autoReset).toBe(true);
    }
  });

  it('keeps the single-pass path unchanged for adapters without foreground content', () => {
    const gpu = renderer(),
      scene = new Scene(),
      camera = new PerspectiveCamera();
    renderAdapter(gpu, { scene, camera });
    expect(gpu.render).toHaveBeenCalledExactlyOnceWith(scene, camera);
    expect(gpu.clearDepth).not.toHaveBeenCalled();
    expect(gpu.info.reset).not.toHaveBeenCalled();
  });

  it('mirrors world-space lights and borrowed environment without a second background or fog', () => {
    const world = new Scene(),
      camera = new PerspectiveCamera();
    world.fog = new Fog('#112233', 1, 10);
    const texture = new DataTexture();
    world.environment = texture;
    world.environmentIntensity = 0.7;
    world.environmentRotation.y = 0.4;
    const parent = new Group();
    parent.position.set(3, 2, 1);
    const point = new PointLight('#ff8800', 7, 12, 1.7);
    point.position.set(1, 2, 3);
    const direction = new DirectionalLight('#aaccff', 2);
    direction.target.position.set(6, 2, 8);
    const hemisphere = new HemisphereLight('#aabbcc', '#223344', 0.4);
    const spot = new SpotLight('#ffffff', 4, 8, 0.4, 0.5, 1.5);
    spot.target.position.set(-4, 1, 2);
    parent.add(point, direction, hemisphere, spot);
    world.add(parent, direction.target, spot.target, new AmbientLight('#334455', 0.3));
    const layer = new ForegroundScene(camera);
    const releasedMap = vi.fn();
    texture.addEventListener('dispose', releasedMap);
    layer.syncLighting(world);
    const lights = [...layer.scene.children];
    const copy = lights.find((light) => light instanceof PointLight);
    expect(copy).toBeInstanceOf(PointLight);
    expect(copy?.position.toArray()).toEqual([4, 4, 4]);
    expect(copy).not.toBe(point);
    const target = lights.find((light) => light instanceof DirectionalLight);
    expect(target).toBeInstanceOf(DirectionalLight);
    if (!(target instanceof DirectionalLight)) throw new Error('Directional copy absent.');
    expect(target.target.getWorldPosition(new Vector3()).toArray()).toEqual([6, 2, 8]);
    expect(layer.scene.background).toBeNull();
    expect(layer.scene.fog).toBeNull();
    expect(layer.scene.environment).toBe(texture);
    expect(layer.scene.environmentIntensity).toBe(0.7);
    expect(layer.scene.environmentRotation.y).toBe(0.4);
    if (!(copy instanceof PointLight)) throw new Error('Point-light copy absent.');
    const released = vi.spyOn(copy, 'dispose');
    point.intensity = 3;
    point.position.x = 2;
    layer.syncLighting(world);
    expect(layer.scene.children).toEqual(lights);
    expect(copy?.position.x).toBe(5);
    expect(copy.intensity).toBe(3);
    parent.remove(point);
    layer.syncLighting(world);
    expect(released).toHaveBeenCalledTimes(1);
    layer.dispose();
    layer.dispose();
    expect(released).toHaveBeenCalledTimes(1);
    expect(releasedMap).not.toHaveBeenCalled();
    expect(world.environment).toBe(texture);
    texture.dispose();
  });
});
