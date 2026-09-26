import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { startAssetPreview } from '@aegis/render-three/preview';
const fetch = globalThis.fetch;

/**
 * @param {{asset: string, out: string, browser?: import('../../../../../packages/render-three/dist/browser.js').LaunchedBrowser}} options
 */
export async function verifyCharacter(options) {
  const asset = resolve(options.asset);
  const out = resolve(options.out);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const before = hash(readFileSync(asset));
  const browserModule = await import(
    pathToFileURL(resolve('packages', 'render-three', 'dist', 'browser.js')).href
  );
  const lifecycle = await import(
    pathToFileURL(resolve('packages', 'render-three', 'dist', 'testing', 'browser-lifecycle.js'))
      .href
  );
  const { launchBrowser, CdpSession, evaluate } = browserModule;
  mkdirSync(out);
  const report = {
    schema: 'cable-warden-deformation-check/1',
    status: 'running',
    asset: basename(asset),
    sha256: before,
    clips: [],
    checks: [],
    scope:
      'Real production loader, decoded textures and sampled skinned geometry; not final human approval',
  };
  let browser = options.browser;
  const ownedBrowser = browser === undefined;
  let preview;
  let cdp;
  try {
    browser ??= await launchBrowser({
      graphics: process.env['AEGIS_CHARACTER_HARDWARE'] === '1' ? 'hardware' : 'software',
      viewport: { width: 1000, height: 1000 },
    });
    preview = await startAssetPreview({
      source: asset,
      outputDir: out,
      repoRoot: process.cwd(),
      browser,
    });
    const host = preview.server.state();
    assert.equal(host.status, 'prepared');
    const targets = await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json();
    const target = targets.find((t) => t.url === preview.url);
    assert.ok(target?.webSocketDebuggerUrl);
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    // Keep browser imports outside serialized functions so test bundling cannot rewrite them.
    await evaluate(
      cdp,
      `(async () => {
      const assets = await import('/vendor/@aegis/render-three/dist/presentation/assets.js');
      globalThis.characterModules = { loadPresentationAssets: assets.loadPresentationAssets, THREE: await import('three') };
      return null;
    })()`,
    );
    async function initialize(config) {
      const document = globalThis.document;
      const { loadPresentationAssets, THREE } = globalThis.characterModules;
      const assets = await loadPresentationAssets(config);
      const instance = assets.instantiateModel(config.manifest.assets[0].id);
      const meshes = [];
      instance.root.traverse((node) => {
        if (node.isMesh) meshes.push(node);
      });
      if (meshes.length !== 1 || !meshes[0].isSkinnedMesh)
        throw new Error('Expected one genuinely skinned character mesh');
      const mesh = meshes[0];
      const positions = mesh.geometry.getAttribute('position');
      const weights = mesh.geometry.getAttribute('skinWeight');
      const joints = mesh.geometry.getAttribute('skinIndex');
      if (!weights || !joints) throw new Error('Skin attributes missing');
      const feet = [[], []];
      const jointNames = mesh.skeleton.bones.map((bone) => bone.name);
      const edgeKeys = new Set();
      const edges = [];
      const indices = mesh.geometry.index.array;
      for (let at = 0; at < indices.length; at += 3) {
        for (const [a, b] of [
          [indices[at], indices[at + 1]],
          [indices[at + 1], indices[at + 2]],
          [indices[at + 2], indices[at]],
        ]) {
          const key = a < b ? `${a}:${b}` : `${b}:${a}`;
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          const length = Math.hypot(
            positions.getX(a) - positions.getX(b),
            positions.getY(a) - positions.getY(b),
            positions.getZ(a) - positions.getZ(b),
          );
          edges.push([a, b, length]);
        }
      }
      let maxWeightError = 0;
      for (let i = 0; i < positions.count; i++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += weights.array[i * 4 + k];
        maxWeightError = Math.max(maxWeightError, Math.abs(sum - 1));
        if (positions.getY(i) <= 0.002) {
          for (let side = 0; side < 2; side++) {
            const name = side === 0 ? 'ankle-left' : 'ankle-right';
            const influence = jointNames.indexOf(name);
            let weight = 0;
            for (let k = 0; k < 4; k++)
              if (joints.array[i * 4 + k] === influence) weight += weights.array[i * 4 + k];
            if (weight > 0.999) feet[side].push(i);
          }
        }
      }
      if (feet.some((vertices) => vertices.length < 8))
        throw new Error(`Missing independently identifiable soles: ${feet.map((f) => f.length)}`);
      const textureFacts = [];
      for (const property of ['map', 'normalMap', 'roughnessMap']) {
        const texture = mesh.material[property];
        if (!texture?.image) throw new Error(`Missing ${property}`);
        const canvas = document.createElement('canvas');
        canvas.width = texture.image.width;
        canvas.height = texture.image.height;
        const context = canvas.getContext('2d');
        context.drawImage(texture.image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let min = 255,
          max = 0;
        for (let i = 0; i < data.length; i += 4) {
          const value = property === 'roughnessMap' ? data[i + 1] : data[i];
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
        if (max - min < 8) throw new Error(`${property} has no meaningful decoded variation`);
        textureFacts.push({ property, width: canvas.width, height: canvas.height, min, max });
      }
      globalThis.characterProbe = { assets, instance, mesh, feet, edges, THREE };
      return {
        vertices: positions.count,
        triangles: mesh.geometry.index.count / 3,
        bones: jointNames,
        soleVertexCounts: feet.map((f) => f.length),
        maxWeightError,
        textures: textureFacts,
        metalness: mesh.material.metalness,
        normalsPresent: mesh.geometry.hasAttribute('normal'),
        clips: instance.clips.map((c) => ({
          name: c.name,
          duration: c.duration,
          tracks: c.tracks.length,
        })),
      };
    }
    report.loaded = await evaluate(
      cdp,
      `(${initialize.toString()})(${JSON.stringify(host.document.presentation)})`,
    );
    assert.deepEqual(report.loaded.clips.map((c) => c.name).sort(), [
      'Idle',
      'Lunge',
      'Search',
      'Stalk',
    ]);
    assert.ok(report.loaded.maxWeightError < 0.00001);
    assert.ok(report.loaded.normalsPresent);
    assert.equal(report.loaded.metalness, 0);

    function measure(name, seconds, emptyAnimation = false) {
      const { instance, mesh, feet, edges, THREE } = globalThis.characterProbe;
      const original = instance.clips.find((c) => c.name === name);
      if (!original) throw new Error(`Missing clip ${name}`);
      if (Math.abs(original.duration - seconds) > 0.00001)
        throw new Error(`Wrong clip duration ${name}`);
      const clip = emptyAnimation ? new THREE.AnimationClip(name, seconds, []) : original;
      const mixer = new THREE.AnimationMixer(instance.root);
      const action = mixer.clipAction(clip).reset().setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      const count = mesh.geometry.getAttribute('position').count;
      const soleSets = feet.map((indices) => new Set(indices));
      const point = new THREE.Vector3();
      const initial = new Float64Array(count * 3);
      const last = new Float64Array(count * 3);
      const bounds = {
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
      };
      const frames = [];
      let maxDisplacement = 0,
        maxContactError = 0,
        maxStanceSlideError = 0,
        maxRootMotion = 0;
      let maxEdgeExtension = 0,
        maxVisibleStretchRatio = 1,
        stretchedEdges = 0;
      let worstEdge;
      const rootBone = instance.root.getObjectByName('root');
      if (!rootBone) throw new Error('Stable root bone missing');
      const rootBaseline = new THREE.Vector3();
      try {
        for (let frame = 0; frame <= Math.round(seconds * 60); frame++) {
          const time = frame / 60;
          mixer.setTime(time);
          instance.root.updateMatrixWorld(true);
          mesh.skeleton.update();
          rootBone.getWorldPosition(point);
          if (frame === 0) rootBaseline.copy(point);
          maxRootMotion = Math.max(maxRootMotion, point.distanceTo(rootBaseline));
          const min = [Infinity, Infinity, Infinity],
            max = [-Infinity, -Infinity, -Infinity];
          const sole = [
            { y: 0, z: 0, x: 0 },
            { y: 0, z: 0, x: 0 },
          ];
          for (let i = 0; i < count; i++) {
            mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld);
            const values = [point.x, point.y, point.z];
            if (!values.every(Number.isFinite))
              throw new Error(`Nonfinite deformed vertex in ${name}`);
            for (let axis = 0; axis < 3; axis++) {
              min[axis] = Math.min(min[axis], values[axis]);
              max[axis] = Math.max(max[axis], values[axis]);
              last[i * 3 + axis] = values[axis];
              if (frame === 0) initial[i * 3 + axis] = values[axis];
            }
            maxDisplacement = Math.max(
              maxDisplacement,
              Math.hypot(
                point.x - initial[i * 3],
                point.y - initial[i * 3 + 1],
                point.z - initial[i * 3 + 2],
              ),
            );
            for (let side = 0; side < 2; side++)
              if (soleSets[side].has(i)) {
                sole[side].y += point.y;
                sole[side].z += point.z;
                sole[side].x += point.x;
              }
          }
          for (let axis = 0; axis < 3; axis++) {
            bounds.min[axis] = Math.min(bounds.min[axis], min[axis]);
            bounds.max[axis] = Math.max(bounds.max[axis], max[axis]);
          }
          for (const [a, b, restLength] of edges) {
            const posedLength = Math.hypot(
              last[a * 3] - last[b * 3],
              last[a * 3 + 1] - last[b * 3 + 1],
              last[a * 3 + 2] - last[b * 3 + 2],
            );
            const extension = posedLength - restLength;
            if (extension > maxEdgeExtension) {
              maxEdgeExtension = extension;
              const position = mesh.geometry.getAttribute('position');
              const skinIndex = mesh.geometry.getAttribute('skinIndex');
              const skinWeight = mesh.geometry.getAttribute('skinWeight');
              const explain = (i) => ({
                position: [position.getX(i), position.getY(i), position.getZ(i)],
                influences: Array.from({ length: 4 }, (_, k) => ({
                  bone: mesh.skeleton.bones[skinIndex.array[i * 4 + k]].name,
                  weight: skinWeight.array[i * 4 + k],
                })),
              });
              worstEdge = { frame, restLength, posedLength, a: explain(a), b: explain(b) };
            }
            if (restLength > 0.001)
              maxVisibleStretchRatio = Math.max(maxVisibleStretchRatio, posedLength / restLength);
            if (extension > 0.025 && posedLength > restLength * 2.5) stretchedEdges++;
          }
          for (let side = 0; side < 2; side++) {
            for (const axis of ['x', 'y', 'z']) sole[side][axis] /= feet[side].length;
            const local = name === 'Stalk' ? (time / 1.1 + side) % 2 : 0;
            const part = local % 1;
            const expectedLift = local >= 1 ? 0.075 * Math.sin(part * Math.PI) ** 2 : 0;
            maxContactError = Math.max(maxContactError, Math.abs(sole[side].y - expectedLift));
            const previous = frames.at(-1);
            if (name === 'Stalk' && previous && local < 1 && (previous.time / 1.1 + side) % 2 < 1) {
              const moved = sole[side].z - previous.sole[side].z;
              maxStanceSlideError = Math.max(maxStanceSlideError, Math.abs(moved + 0.8 / 1.1 / 60));
            }
          }
          frames.push({ frame, time, min, max, sole });
        }
        let loopError = 0;
        for (let i = 0; i < initial.length; i++)
          loopError = Math.max(loopError, Math.abs(initial[i] - last[i]));
        return {
          name,
          duration: original.duration,
          bounds,
          maxDisplacement,
          maxContactError,
          maxStanceSlideError,
          maxRootMotion,
          maxEdgeExtension,
          maxVisibleStretchRatio,
          stretchedEdges,
          worstEdge,
          loopError: name === 'Lunge' ? null : loopError,
          frames,
        };
      } finally {
        mixer.stopAllAction();
        mixer.uncacheRoot(instance.root);
      }
    }
    const oldBounds = {
      Idle: { min: [-0.3941689, -0.00000001, -0.326196], max: [0.385, 2.0363009, 0.2677025] },
      Stalk: { min: [-0.4081689, -0.0016317, -0.5235], max: [0.399, 2.0361947, 0.6510001] },
      Search: {
        min: [-0.4028989, -0.00000001, -0.3374005],
        max: [0.3853324, 2.0290001, 0.2779034],
      },
      Lunge: { min: [-0.3941689, -0.00000001, -0.3580039], max: [0.385, 2.0327766, 0.7801432] },
    };
    for (const [name, duration, threshold] of [
      ['Idle', 3.4, 0.005],
      ['Stalk', 2.2, 0.2],
      ['Search', 4.4, 0.05],
      ['Lunge', 0.8, 0.15],
    ]) {
      const measured = await evaluate(
        cdp,
        `(${measure.toString()})(${JSON.stringify(name)},${duration})`,
      );
      report.clips.push(measured);
      const check = (label, ok, actual) => report.checks.push({ clip: name, label, ok, actual });
      check(
        'actual skinned vertex deformation',
        measured.maxDisplacement > threshold,
        measured.maxDisplacement,
      );
      check(
        'sole contact/lift within 3mm',
        measured.maxContactError < 0.003,
        measured.maxContactError,
      );
      check('no locomotion root motion', measured.maxRootMotion < 0.00001, measured.maxRootMotion);
      check('no visibly stretched skin membranes', measured.stretchedEdges === 0, {
        occurrences: measured.stretchedEdges,
        maxExtension: measured.maxEdgeExtension,
        maxRatio: measured.maxVisibleStretchRatio,
      });
      check(
        'no floor penetration beyond 3mm',
        measured.bounds.min[1] >= -0.003,
        measured.bounds.min[1],
      );
      check(
        'matches existing clip clearance envelope within 25mm',
        [0, 1, 2].every(
          (axis) =>
            measured.bounds.min[axis] >= oldBounds[name].min[axis] - 0.025 &&
            measured.bounds.max[axis] <= oldBounds[name].max[axis] + 0.025,
        ),
        measured.bounds,
      );
      if (name !== 'Lunge')
        check('loop closes within 1mm', measured.loopError < 0.001, measured.loopError);
      if (name === 'Stalk')
        check(
          'planted stride matches 1.6m per cycle',
          measured.maxStanceSlideError < 0.0005,
          measured.maxStanceSlideError,
        );
      console.log(JSON.stringify({ ...measured, frames: undefined }));
    }
    const staticControl = await evaluate(cdp, `(${measure.toString()})("Stalk",2.2,true)`);
    assert.ok(staticControl.maxDisplacement < 1e-8, 'Static mutation must have no vertex motion');
    report.staticMutationRejected = staticControl.maxDisplacement <= 0.2;
    report.captures = [];
    for (const [name, time] of [
      ['Idle', 0],
      ['Stalk', 0.275],
      ['Stalk', 0.825],
      ['Search', 1.1],
      ['Lunge', 0.52],
    ]) {
      const capture = await preview.capture({
        filename: `${name.toLowerCase()}-${String(time).replace('.', '-')}.png`,
        width: 900,
        height: 1200,
        settings: {
          clip: name,
          time,
          projection: 'orthographic',
          lighting: 'neutral',
          background: '#777b80',
          camera: { position: [3, 1.1, 5], target: [0, 1.05, 0], orthographicHeight: 2.35 },
        },
      });
      report.captures.push({
        file: basename(capture.output.path),
        sha256: capture.output.sha256,
        poseHash: capture.stats.poseSampleHash,
      });
    }
    assert.equal(hash(readFileSync(asset)), before);
    report.status = report.checks.every((check) => check.ok)
      ? 'passed-pending-visual-approval'
      : 'failed-contract';
  } catch (error) {
    report.status = 'failed';
    report.error = String(error.stack ?? error);
  } finally {
    const failures = [];
    try {
      if (cdp)
        await evaluate(
          cdp,
          'globalThis.characterProbe?.instance.dispose(); globalThis.characterProbe?.assets.dispose(); null',
        );
    } catch (error) {
      failures.push(String(error));
    }
    cdp?.close();
    try {
      await preview?.close();
    } catch (error) {
      failures.push(String(error));
    }
    if (ownedBrowser && browser) {
      try {
        await lifecycle.closeOwnedBrowser(browser, { inspectProcesses: true });
        rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (failures.length) {
      report.cleanupErrors = failures;
      report.status = 'failed';
    }
    writeFileSync(join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log(
      JSON.stringify({
        status: report.status,
        failures: report.checks.filter((check) => !check.ok),
        error: report.error,
      }),
    );
  }
  return report;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.equal(
    args.length,
    4,
    'Usage: node verify-character.mjs --asset <GLB> --out <new-directory>',
  );
  assert.equal(args[0], '--asset');
  assert.equal(args[2], '--out');
  const report = await verifyCharacter({ asset: args[1], out: args[3] });
  if (report.status !== 'passed-pending-visual-approval') process.exitCode = 1;
}
