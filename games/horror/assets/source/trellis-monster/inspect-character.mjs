import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function parseCharacterGlb(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  let document;
  let binary;
  for (let at = 12; at < bytes.length;) {
    const length = bytes.readUInt32LE(at);
    const type = bytes.readUInt32LE(at + 4);
    assert.ok(at + 8 + length <= bytes.length, 'GLB chunk bounds');
    if (type === 0x4e4f534a) document = JSON.parse(bytes.toString('utf8', at + 8, at + 8 + length));
    if (type === 0x004e4942) binary = bytes.subarray(at + 8, at + 8 + length);
    at += length + 8;
  }
  assert.ok(document && binary, 'GLB JSON and binary are required');
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const components = {
    5121: [1, 'readUInt8'],
    5123: [2, 'readUInt16LE'],
    5125: [4, 'readUInt32LE'],
    5126: [4, 'readFloatLE'],
  };
  const accessor = (index) => {
    const a = document.accessors[index],
      view = document.bufferViews[a.bufferView];
    const width = widths[a.type],
      component = components[a.componentType];
    assert.ok(width && component && a.count > 0, 'Supported nonempty accessor');
    return Array.from({ length: a.count }, (_, row) =>
      Array.from({ length: width }, (_, column) =>
        binary[component[1]](
          (view.byteOffset ?? 0) +
            (a.byteOffset ?? 0) +
            row * (view.byteStride ?? width * component[0]) +
            column * component[0],
        ),
      ),
    );
  };
  return { document, binary, accessor };
}

export function inspectCharacterGlb(bytes) {
  const { document: doc, binary, accessor } = parseCharacterGlb(bytes);
  assert.equal(doc.skins?.length, 1, 'One real character skin is required');
  assert.equal(doc.skins[0].joints.length, 24, 'The measured 24-joint rig must remain intact');
  assert.equal(doc.meshes.length, 1, 'One compact character mesh is expected');
  assert.equal(doc.meshes[0].primitives.length, 1, 'One compact material primitive is expected');
  const primitive = doc.meshes[0].primitives[0];
  for (const field of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'])
    assert.ok(
      Number.isInteger(primitive.attributes[field]),
      `Required ${field} attribute is missing`,
    );
  const positions = accessor(primitive.attributes.POSITION);
  assert.ok(positions.flat().every(Number.isFinite), 'Finite positions required');
  const weights = accessor(primitive.attributes.WEIGHTS_0);
  const joints = accessor(primitive.attributes.JOINTS_0);
  for (let i = 0; i < weights.length; i++) {
    assert.ok(weights[i].every((value) => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(
      Math.abs(weights[i].reduce((a, b) => a + b, 0) - 1) < 0.00001,
      'Normalized skin weights required',
    );
    assert.ok(joints[i].every((value) => Number.isInteger(value) && value >= 0 && value < 24));
  }
  const triangles = doc.accessors[primitive.indices].count / 3;
  assert.equal(triangles, 33273, 'Measured cooked topology changed');
  assert.ok(triangles <= 65382);
  const material = doc.materials[primitive.material];
  assert.equal(
    material.pbrMetallicRoughness.metallicFactor,
    0,
    'Organic tissue must not inherit glTF metallic=1',
  );
  assert.ok(material.normalTexture, 'Baked normal texture required');
  assert.ok(material.pbrMetallicRoughness.baseColorTexture, 'Baked base-color texture required');
  assert.ok(
    material.pbrMetallicRoughness.metallicRoughnessTexture,
    'Baked roughness texture required',
  );
  const textures = [];
  for (const [name, entry, size] of [
    ['normal', material.normalTexture, 1024],
    ['basecolor', material.pbrMetallicRoughness.baseColorTexture, 2048],
    ['roughness', material.pbrMetallicRoughness.metallicRoughnessTexture, 1024],
  ]) {
    const image = doc.images[doc.textures[entry.index].source];
    assert.equal(image.mimeType, 'image/png');
    assert.ok(Number.isInteger(image.bufferView), 'Cooked textures must be embedded');
    const view = doc.bufferViews[image.bufferView];
    const png = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), size, `${name} width`);
    assert.equal(png.readUInt32BE(20), size, `${name} height`);
    textures.push({ name, width: size, height: size, bytes: png.length });
  }
  const durations = { Idle: 3.4, Stalk: 2.2, Search: 4.4, Lunge: 0.8 };
  assert.deepEqual(
    doc.animations.map((animation) => animation.name).sort(),
    Object.keys(durations).sort(),
    'Required semantic clip inventory',
  );
  const clips = [];
  for (const clip of doc.animations) {
    let end = 0,
      varyingBones = 0;
    for (const channel of clip.channels) {
      const sampler = clip.samplers[channel.sampler];
      const times = accessor(sampler.input).flat(),
        values = accessor(sampler.output);
      end = Math.max(end, ...times);
      const varies = values.some((value) =>
        value.some((item, i) => Math.abs(item - values[0][i]) > 0.00001),
      );
      if (doc.nodes[channel.target.node].name === 'root')
        assert.equal(varies, false, 'Locomotion root motion is forbidden');
      else if (doc.skins[0].joints.includes(channel.target.node) && varies) varyingBones++;
    }
    assert.ok(Math.abs(end - durations[clip.name]) < 0.00001, `Wrong ${clip.name} duration`);
    assert.ok(varyingBones > 0, `Static character in ${clip.name}`);
    clips.push({ name: clip.name, duration: end, varyingBoneTracks: varyingBones });
  }
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    triangles,
    vertices: positions.length,
    textures,
    clips,
  };
}

export function verifyCharacterReceipt(bytes, receipt) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(receipt.aegis, 'asset-import/1');
  assert.equal(receipt.files.length, 1);
  assert.equal(receipt.files[0].path, 'model/responder.glb');
  assert.equal(receipt.files[0].sha256, hash, 'Stale imported character receipt');
  assert.equal(receipt.files[0].bytes, bytes.length, 'Stale imported character byte count');
}
