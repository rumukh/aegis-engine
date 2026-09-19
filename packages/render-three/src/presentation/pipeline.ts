import {
  ACESFilmicToneMapping,
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PCFSoftShadowMap,
  PMREMGenerator,
  SRGBColorSpace,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import type { WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import type { RenderAdapter } from '../adapter.js';
import type { PresentationAssets } from './assets.js';
import { CINEMATIC_QUALITY, QUALITY } from './schema.js';
import type { PresentationManifest, QualityTier } from './schema.js';

type View = Pick<RenderAdapter, 'scene' | 'camera' | 'foreground'>;

export function cinematicSize(
  width: number,
  height: number,
  dpr: number,
  quality: QualityTier,
): { width: number; height: number } {
  if (![width, height, dpr].every((v) => Number.isFinite(v) && v > 0))
    throw new Error(
      '[aegis:pipeline] Viewport dimensions and pixel ratio must be finite and positive.',
    );
  const ratio = Math.min(
    dpr,
    QUALITY[quality].pixelRatio,
    Math.sqrt(CINEMATIC_QUALITY[quality].pixels / (width * height)),
    8192 / Math.max(width, height),
  );
  return {
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
  };
}

class ForegroundLinearPass extends Pass {
  constructor(readonly view: () => View) {
    super();
    this.needsSwap = false;
  }
  override render(
    renderer: WebGLRenderer,
    _write: WebGLRenderTarget,
    read: WebGLRenderTarget,
  ): void {
    const foreground = this.view().foreground;
    if (foreground === undefined) return;
    const autoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(read);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(foreground.scene, foreground.camera);
    } finally {
      renderer.autoClear = autoClear;
    }
  }
}

class WorldOcclusionPass extends SSAOPass {
  override render(
    renderer: WebGLRenderer,
    write: WebGLRenderTarget,
    read: WebGLRenderTarget,
  ): void {
    const autoUpdate = renderer.shadowMap.autoUpdate;
    const needsUpdate = renderer.shadowMap.needsUpdate;
    try {
      // The beauty pass already updated shadows; the normals-only pass must not render them again.
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = false;
      super.render(renderer, write, read, 0, false);
    } finally {
      renderer.shadowMap.autoUpdate = autoUpdate;
      renderer.shadowMap.needsUpdate = needsUpdate;
    }
  }
}

/** Linear HDR world -> AO -> foreground -> bloom/grade -> one ACES/sRGB output transform. */
export class CinematicPipeline {
  readonly #renderer: WebGLRenderer;
  readonly #composer: EffectComposer;
  readonly #world: RenderPass;
  readonly #ao?: SSAOPass;
  readonly #bloom?: UnrealBloomPass;
  readonly #foreground: ForegroundLinearPass;
  readonly #grade: ShaderPass;
  readonly #output = new OutputPass();
  readonly #environment: View['scene']['environment'];
  readonly #environmentScene: View['scene'];
  readonly #environmentIntensity: number;
  readonly #previous;
  readonly #shadowMeshes = new WeakSet<Mesh>();
  #reflection?: WebGLRenderTarget;
  #view: View;
  #quality: QualityTier;
  #width = 1;
  #height = 1;
  #disposed = false;

  constructor(
    renderer: WebGLRenderer,
    view: View,
    manifest: PresentationManifest,
    assets: PresentationAssets,
    quality: QualityTier = manifest.quality ?? 'standard',
  ) {
    const spec = manifest.pipeline;
    if (spec === undefined)
      throw new Error('[aegis:pipeline] A cinematic pipeline must be explicitly declared.');
    this.#renderer = renderer;
    this.#view = view;
    this.#quality = quality;
    this.#environment = view.scene.environment;
    this.#environmentScene = view.scene;
    this.#environmentIntensity = view.scene.environmentIntensity;
    this.#previous = {
      toneMapping: renderer.toneMapping,
      exposure: renderer.toneMappingExposure,
      colorSpace: renderer.outputColorSpace,
      shadows: renderer.shadowMap.enabled,
      shadowType: renderer.shadowMap.type,
    };
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true });
    this.#composer = new EffectComposer(renderer, target);
    this.#composer.setPixelRatio(1);
    this.#world = new RenderPass(view.scene, view.camera);
    this.#composer.addPass(this.#world);
    if (spec.ambientOcclusion !== undefined) {
      this.#ao = new WorldOcclusionPass(view.scene, view.camera, 1, 1, 16);
      this.#ao.kernelRadius = spec.ambientOcclusion.radius;
      this.#ao.minDistance = spec.ambientOcclusion.minDistance;
      this.#ao.maxDistance = spec.ambientOcclusion.maxDistance;
      this.#composer.addPass(this.#ao);
    }
    this.#foreground = new ForegroundLinearPass(() => this.#view);
    this.#composer.addPass(this.#foreground);
    if (spec.bloom !== undefined) {
      this.#bloom = new UnrealBloomPass(
        new Vector2(1, 1),
        spec.bloom.strength,
        spec.bloom.radius,
        spec.bloom.threshold,
      );
      this.#composer.addPass(this.#bloom);
    }
    this.#grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, saturation: { value: spec.saturation ?? 1 } },
      vertexShader:
        'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:
        'uniform sampler2D tDiffuse; uniform float saturation; varying vec2 vUv; void main(){vec4 c=texture2D(tDiffuse,vUv);float l=dot(c.rgb,vec3(0.2126,0.7152,0.0722));gl_FragColor=vec4(max(vec3(0.0),mix(vec3(l),c.rgb,saturation)),c.a);}',
    });
    this.#composer.addPass(this.#grade);
    this.#composer.addPass(this.#output);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = spec.exposure ?? 1;
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    try {
      const reflections = manifest.environment?.reflections;
      if (reflections !== undefined) {
        const generator = new PMREMGenerator(renderer);
        try {
          this.#reflection = generator.fromEquirectangular(assets.texture(reflections.texture));
          view.scene.environment = this.#reflection.texture;
          view.scene.environmentIntensity = reflections.intensity ?? 1;
        } finally {
          generator.dispose();
        }
      }
      this.setQuality(quality);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  setQuality(quality: QualityTier): void {
    this.#quality = quality;
    const settings = CINEMATIC_QUALITY[quality];
    if (this.#ao !== undefined) this.#ao.enabled = settings.ao;
    if (this.#bloom !== undefined) this.#bloom.enabled = settings.bloom;
    const samples = quality === 'photo' ? 4 : quality === 'low' ? 0 : 2;
    for (const target of [this.#composer.renderTarget1, this.#composer.renderTarget2]) {
      if (target.samples !== samples) {
        target.samples = samples;
        target.dispose();
      }
    }
  }

  resize(width: number, height: number): void {
    this.#width = width;
    this.#height = height;
    this.#composer.setSize(width, height);
  }

  render(view: View = this.#view): void {
    if (this.#disposed) throw new Error('[aegis:pipeline] Cannot render a disposed pipeline.');
    this.#view = view;
    this.#world.scene = view.scene;
    this.#world.camera = view.camera;
    if (this.#ao !== undefined) {
      this.#ao.scene = view.scene;
      this.#ao.camera = view.camera;
      this.#ao.setSize(this.#width, this.#height);
      if (view.camera instanceof PerspectiveCamera || view.camera instanceof OrthographicCamera) {
        const uniforms = this.#ao.ssaoMaterial.uniforms;
        uniforms['cameraNear']!.value = view.camera.near;
        uniforms['cameraFar']!.value = view.camera.far;
        const perspective = view.camera instanceof PerspectiveCamera ? 1 : 0;
        if (this.#ao.ssaoMaterial.defines['PERSPECTIVE_CAMERA'] !== perspective) {
          this.#ao.ssaoMaterial.defines['PERSPECTIVE_CAMERA'] = perspective;
          this.#ao.ssaoMaterial.needsUpdate = true;
        }
      }
    }
    view.scene.traverse((node) => {
      if (!(node instanceof Mesh) || this.#shadowMeshes.has(node)) return;
      this.#shadowMeshes.add(node);
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      node.castShadow = materials.every((m) => !m.transparent || m.alphaTest > 0);
      node.receiveShadow = true;
    });
    const renderer = this.#renderer;
    const autoReset = renderer.info.autoReset;
    const autoClear = renderer.autoClear;
    const target = renderer.getRenderTarget();
    try {
      renderer.info.autoReset = false;
      if (autoReset) renderer.info.reset();
      this.#composer.render(0);
    } finally {
      renderer.info.autoReset = autoReset;
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target);
    }
  }

  stats(): object {
    return {
      width: this.#width,
      height: this.#height,
      pixels: this.#width * this.#height,
      pixelBudget: CINEMATIC_QUALITY[this.#quality].pixels,
      quality: this.#quality,
      passes: this.#composer.passes.filter((pass) => pass.enabled).length,
      ambientOcclusion: this.#ao?.enabled ?? false,
      bloom: this.#bloom?.enabled ?? false,
      toneMapping: 'aces',
      outputTransforms: 1,
      msaaSamples: this.#composer.renderTarget1.samples,
      reflections: this.#reflection !== undefined,
      drawCalls: this.#renderer.info.render.calls,
      triangles: this.#renderer.info.render.triangles,
      gpuResources: { ...this.#renderer.info.memory },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pass of this.#composer.passes) pass.dispose();
    // three r169's SSAOPass.dispose omits its main shader and noise texture.
    this.#ao?.ssaoMaterial.dispose();
    this.#ao?.noiseTexture.dispose();
    this.#composer.dispose();
    this.#environmentScene.environment = this.#environment;
    this.#environmentScene.environmentIntensity = this.#environmentIntensity;
    this.#reflection?.dispose();
    this.#reflection = undefined;
    this.#renderer.toneMapping = this.#previous.toneMapping;
    this.#renderer.toneMappingExposure = this.#previous.exposure;
    this.#renderer.outputColorSpace = this.#previous.colorSpace;
    this.#renderer.shadowMap.enabled = this.#previous.shadows;
    this.#renderer.shadowMap.type = this.#previous.shadowType;
  }
}
