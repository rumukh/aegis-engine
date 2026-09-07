/**
 * Node-only preflight for the files a presentation can load. The returned inventory, not an
 * asset directory, is the authority for both the dev server and the static exporter.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { DiagnosticError } from '@aegis/core';
import type { Diagnostic } from '@aegis/core';
import type { EntityDecl, SceneFile } from '@aegis/content';
import { isAssetPath, renderDiagnostic, RenderCode } from './diagnostics.js';
import { PRESENTATION_LIMITS } from './schema.js';
import type { PresentationManifest, PresentationSource, Provenance } from './schema.js';
import { validatePresentation } from './validate.js';

export interface PreparedPresentationFile {
  /** Portable URL path relative to the asset root. */
  path: string;
  /** Resolved real host path. Never embed this in a page or public inventory. */
  source: string;
  bytes: number;
  sha256: string;
  provenance?: Provenance;
}

export interface PreparedPresentation {
  manifest: PresentationManifest;
  files: readonly PreparedPresentationFile[];
  totalBytes: number;
  /** Nonfatal notes. Deferred names must still be validated against the initialized world. */
  diagnostics?: readonly Diagnostic[];
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const AUDIO_MIME: Readonly<Record<string, string>> = {
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};
const ASSET_MIME: Readonly<Record<string, string>> = {
  ...IMAGE_MIME,
  ...AUDIO_MIME,
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
};

/** Asset responses never inherit the vendor endpoint's executable HTML/JavaScript MIME types. */
export function presentationMimeType(path: string): string {
  return ASSET_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

const SUPPORTED_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_anisotropy',
  'KHR_materials_clearcoat',
  'KHR_materials_dispersion',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_iridescence',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_mesh_quantization',
  'KHR_texture_transform',
  'EXT_materials_bump',
  'EXT_mesh_gpu_instancing',
  'EXT_texture_webp',
]);
const DECODER_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
  'EXT_texture_avif',
]);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;

function fail(code: string, path: string, message: string, fix: string, file?: string): never {
  throw new DiagnosticError([renderDiagnostic(code, path, message, fix, file)]);
}

/** Windows device names and trailing dots are not portable, even on a POSIX authoring host. */
function portablePath(path: string): boolean {
  return (
    isAssetPath(path) &&
    path
      .split('/')
      .every(
        (part) =>
          !part.endsWith('.') && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  );
}

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

function checkScene(manifest: PresentationManifest, scene: SceneFile): readonly Diagnostic[] {
  const names = new Set<string>();
  const visit = (entities: readonly EntityDecl[]): void => {
    for (const entity of entities) {
      names.add(entity.id);
      visit(entity.children ?? []);
    }
  };
  visit(scene.entities);
  const diagnostics: Diagnostic[] = [];
  const check = (name: string, path: string): void => {
    if (names.has(name)) return;
    diagnostics.push({
      ...renderDiagnostic(
        RenderCode.Reference,
        path,
        `Name checking for entity "${name}" in scene "${scene.name}" is deferred: plugin initialization or prefab expansion can introduce names absent from the raw scene.`,
        'Validate this name against the fully initialized world before the first mount; reject it if it is still missing.',
      ),
      severity: 'warning',
      data: { entity: name, deferred: true, reason: 'world-initialization' },
    });
  };
  manifest.entities?.forEach((binding, index) => {
    if ('name' in binding.target) check(binding.target.name, `entities[${index}].target.name`);
  });
  manifest.objects?.forEach((decoration, index) => {
    if (typeof decoration.anchor === 'object')
      check(decoration.anchor.entity, `objects[${index}].anchor.entity`);
  });
  manifest.effects?.forEach((effect, index) => {
    if ('entity' in effect.target) check(effect.target.entity, `effects[${index}].target.entity`);
  });
  if (manifest.hud !== undefined) check(manifest.hud.playerName, 'hud.playerName');
  return diagnostics;
}

/**
 * Validate and inventory synchronously, without importing a browser loader or expanding prefabs.
 * Every raw-scene missing name produces a deferred diagnostic, including scenes without prefabs:
 * plugin initialization can create Names too. The initialized world is the strict name boundary.
 * Shape and asset validation are never deferred. Omitting scene leaves all name checks to mount.
 */
export function preparePresentation(
  source: PresentationSource,
  scene?: SceneFile,
): PreparedPresentation {
  const validated = validatePresentation(source.manifest);
  if (!validated.ok || validated.value === undefined)
    throw new DiagnosticError(validated.diagnostics);
  const manifest = structuredClone(validated.value);
  const diagnostics = scene === undefined ? [] : checkScene(manifest, scene);
  const notes = diagnostics.length === 0 ? {} : { diagnostics };
  const assets = manifest.assets ?? [];
  if (assets.length === 0) return { manifest, files: [], totalBytes: 0, ...notes };
  if (typeof source.assetRoot !== 'string' || !isAbsolute(source.assetRoot))
    fail(
      RenderCode.Path,
      'assetRoot',
      `Presentation declares file assets (${assets.map((asset) => asset.id).join(', ')}) without an absolute assetRoot.`,
      'Set assetRoot to the absolute directory containing the declared local files.',
    );
  let root: string;
  try {
    root = realpathSync(source.assetRoot);
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch {
    fail(
      RenderCode.Path,
      'assetRoot',
      `The presentation assetRoot "${source.assetRoot}" is not a readable directory.`,
      'Create the asset directory and point assetRoot at it before serving or exporting.',
    );
  }

  const inventory = new Map<string, { file: PreparedPresentationFile; contents: Buffer }>();
  const casePaths = new Map<string, string>();
  const provenanceByPath = new Map<string, Provenance>();
  for (const [index, asset] of assets.entries()) {
    const previous = provenanceByPath.get(asset.src);
    if (
      previous !== undefined &&
      (previous.author !== asset.provenance.author ||
        previous.license !== asset.provenance.license ||
        previous.source !== asset.provenance.source)
    )
      fail(
        RenderCode.Reference,
        `assets[${index}].provenance`,
        `Asset "${asset.id}" gives conflicting provenance for shared file "${asset.src}".`,
        'Use the same author, license, and source for each declaration of this file.',
      );
    provenanceByPath.set(asset.src, asset.provenance);
  }
  let totalBytes = 0;

  for (const [index, asset] of assets.entries()) {
    const location = `assets[${index}]`;
    function reject(
      code: string,
      field: string,
      message: string,
      fix: string,
      file = asset.src,
    ): never {
      return fail(code, `${location}.${field}`, `Asset "${asset.id}": ${message}`, fix, file);
    }
    const read = (path: string, field: string): Buffer => {
      if (!portablePath(path))
        reject(
          RenderCode.Path,
          field,
          `"${path}" is not a safe portable relative file path.`,
          'Use slash-separated local names without traversal, encoding, queries, fragments, or device names.',
        );
      const previousCase = casePaths.get(path.toLowerCase());
      if (previousCase !== undefined && previousCase !== path)
        reject(
          RenderCode.Path,
          field,
          `"${path}" conflicts with "${previousCase}" on case-insensitive filesystems.`,
          'Use one exact spelling for each path on all authoring and deployment platforms.',
        );
      const existing = inventory.get(path);
      if (existing !== undefined) return existing.contents;
      if (inventory.size >= PRESENTATION_LIMITS.assets)
        reject(
          RenderCode.Budget,
          field,
          `The local dependency closure exceeds ${PRESENTATION_LIMITS.assets} files.`,
          'Consolidate buffers or texture atlases and reduce the number of local files.',
        );
      let real: string;
      let bytes: number;
      try {
        real = realpathSync(join(root, ...path.split('/')));
        const stat = statSync(real);
        if (!stat.isFile()) throw new Error('not a regular file');
        bytes = stat.size;
      } catch {
        reject(
          RenderCode.Asset,
          field,
          `Required file "${path}" is missing or is not a readable regular file.`,
          'Place the file at this path under assetRoot, preserving its relative directory.',
        );
      }
      if (!inside(root, real))
        reject(
          RenderCode.Path,
          field,
          `"${path}" resolves outside assetRoot through a symlink.`,
          'Keep the file and every symlink target inside the resolved assetRoot directory.',
        );
      const budget = (size: number): void => {
        if (
          size > PRESENTATION_LIMITS.fileBytes ||
          totalBytes + size > PRESENTATION_LIMITS.totalBytes
        )
          reject(
            RenderCode.Budget,
            field,
            `"${path}" (${size} bytes) exceeds the ${PRESENTATION_LIMITS.fileBytes}-byte file or ${PRESENTATION_LIMITS.totalBytes}-byte total budget.`,
            'Reduce asset sizes; embedded resources and glTF dependencies count toward these limits.',
          );
      };
      budget(bytes);
      let contents: Buffer;
      try {
        contents = readFileSync(real);
      } catch {
        reject(
          RenderCode.Asset,
          field,
          `Required file "${path}" cannot be read.`,
          'Check file permissions and rerun presentation preflight.',
        );
      }
      budget(contents.length);
      totalBytes += contents.length;
      casePaths.set(path.toLowerCase(), path);
      inventory.set(path, {
        file: {
          path,
          source: real,
          bytes: contents.length,
          sha256: createHash('sha256').update(contents).digest('hex'),
          provenance: provenanceByPath.get(path) ?? asset.provenance,
        },
        contents,
      });
      return contents;
    };

    const image = (bytes: Buffer, mime: string, field: string, depth = 0): void => {
      if (!Object.values(IMAGE_MIME).includes(mime))
        reject(
          RenderCode.Unsupported,
          field,
          `Unsupported image format "${mime}".`,
          'Use PNG, JPEG, WebP, or a self-contained SVG image.',
        );
      if (mime === 'image/svg+xml') {
        if (depth > 8)
          reject(
            RenderCode.Budget,
            field,
            'SVG data images are nested too deeply.',
            'Flatten the SVG image.',
          );
        const svg = bytes
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .replace(/<!--[\s\S]*?-->/g, '');
        // Decode character references before looking at href/url values; XML entities must not
        // turn an apparently local value into an external request in the browser.
        const decoded = svg.replace(
          /&#(?:x([0-9a-f]+)|([0-9]+));/gi,
          (_all, hex: string | undefined, dec: string | undefined) => {
            const value = Number.parseInt(hex ?? dec ?? '', hex === undefined ? 10 : 16);
            return value <= 0x10ffff ? String.fromCodePoint(value) : '\uFFFD';
          },
        );
        if (
          !/^\s*(?:<\?xml\s[^?]*\?>\s*)?<svg[\s>]/i.test(decoded) ||
          /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|<\s*(?:script|foreignObject|animate(?:Motion|Transform)?|set)\b|\son[a-z]+\s*=|\b(?:[\w-]+:)?base\s*=/i.test(
            decoded,
          ) ||
          /@import|@font-face|\b(?:image|image-set|expression)\s*\(|\\/i.test(decoded)
        )
          reject(
            RenderCode.Unsupported,
            field,
            'SVG must be self-contained, without scripts, external XML, animated links, CSS imports, or escaped CSS references.',
            'Flatten external artwork into local paths or embedded raster images and remove active content.',
          );
        const local = (reference: string): void => {
          const value = reference.trim();
          if (/^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)) return;
          if (value.startsWith('data:')) {
            embedded(value, 'image', field, depth + 1);
            return;
          }
          reject(
            RenderCode.Unsupported,
            field,
            `SVG references non-embedded resource "${value}".`,
            'Use fragment references to this SVG or embedded PNG/JPEG/WebP data images.',
          );
        };
        for (const match of decoded.matchAll(/\b(?:[\w-]+:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
          local(match[1] ?? match[2] ?? '');
        for (const match of decoded.matchAll(/\burl\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi))
          local(match[1] ?? match[2] ?? match[3] ?? '');
        return;
      }
      const valid =
        (mime === 'image/png' &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
        (mime === 'image/webp' &&
          bytes.toString('ascii', 0, 4) === 'RIFF' &&
          bytes.toString('ascii', 8, 12) === 'WEBP');
      if (!valid)
        reject(
          RenderCode.Asset,
          field,
          `The image bytes do not match "${mime}".`,
          'Export a valid image in the declared file format.',
        );
    };

    const embedded = (uri: string, kind: 'image' | 'buffer', field: string, depth = 0): Buffer => {
      const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(uri);
      if (match === null)
        reject(
          RenderCode.Asset,
          field,
          'Malformed embedded data URI.',
          'Use a data:<mime>;base64,<payload> URI.',
        );
      const mime = (match[1] ?? '').toLowerCase();
      const payload = match[3] ?? '';
      let bytes: Buffer;
      try {
        if (match[2] !== undefined) {
          const data = payload.replace(/\s/g, '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1)
            throw new Error('invalid base64');
          bytes = Buffer.from(data, 'base64');
        } else {
          const encoded = Buffer.from(payload, 'utf8');
          const decoded = Buffer.allocUnsafe(encoded.length);
          let length = 0;
          for (let at = 0; at < encoded.length; at++) {
            if (encoded[at] !== 0x25) decoded[length++] = encoded[at] as number;
            else {
              const hex = encoded.toString('ascii', at + 1, at + 3);
              if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error('invalid percent encoding');
              decoded[length++] = Number.parseInt(hex, 16);
              at += 2;
            }
          }
          bytes = decoded.subarray(0, length);
        }
      } catch {
        reject(
          RenderCode.Asset,
          field,
          'Malformed embedded data payload.',
          'Re-export a valid base64-encoded resource.',
        );
      }
      if (bytes.length > PRESENTATION_LIMITS.fileBytes)
        reject(
          RenderCode.Budget,
          field,
          'An embedded resource exceeds the file byte limit.',
          'Reduce the embedded resource size.',
        );
      if (kind === 'image') image(bytes, mime, field, depth);
      else if (!['application/octet-stream', 'application/gltf-buffer'].includes(mime))
        reject(
          RenderCode.Unsupported,
          field,
          `Unsupported buffer MIME "${mime}".`,
          'Use application/octet-stream or application/gltf-buffer.',
        );
      return bytes;
    };

    const contents = read(asset.src, 'src');
    const extension = extname(asset.src).toLowerCase();
    if (asset.kind === 'texture') {
      image(contents, IMAGE_MIME[extension] ?? extension, 'src');
      continue;
    }
    if (asset.kind === 'audio') {
      const mime = AUDIO_MIME[extension];
      if (mime === undefined)
        reject(
          RenderCode.Unsupported,
          'src',
          `Unsupported audio format "${extension}".`,
          'Use WAV, OGG, or MP3 audio.',
        );
      const valid =
        (extension === '.wav' &&
          contents.toString('ascii', 0, 4) === 'RIFF' &&
          contents.toString('ascii', 8, 12) === 'WAVE') ||
        (extension === '.ogg' && contents.toString('ascii', 0, 4) === 'OggS') ||
        (extension === '.mp3' &&
          (contents.toString('ascii', 0, 3) === 'ID3' ||
            (contents[0] === 0xff && ((contents[1] ?? 0) & 0xe0) === 0xe0)));
      if (!valid)
        reject(
          RenderCode.Asset,
          'src',
          `The audio bytes do not match "${mime}".`,
          'Export valid audio in the declared file format.',
        );
      continue;
    }
    if (extension !== '.gltf' && extension !== '.glb')
      reject(
        RenderCode.Unsupported,
        'src',
        `Unsupported model format "${extension}".`,
        'Export an uncompressed glTF 2.0 .gltf or .glb model.',
      );

    let json = contents;
    let binary: Buffer | undefined;
    if (extension === '.glb') {
      const invalid = (): never =>
        reject(
          RenderCode.Asset,
          'src',
          'Malformed GLB header or chunks.',
          'Re-export a glTF 2.0 GLB with a JSON chunk and optional BIN chunk.',
        );
      if (
        contents.length < 20 ||
        contents.toString('ascii', 0, 4) !== 'glTF' ||
        contents.readUInt32LE(4) !== 2 ||
        contents.readUInt32LE(8) !== contents.length
      )
        invalid();
      let offset = 12;
      let chunks = 0;
      while (offset < contents.length) {
        if (offset + 8 > contents.length) invalid();
        const length = contents.readUInt32LE(offset);
        const type = contents.readUInt32LE(offset + 4);
        offset += 8;
        if (length % 4 !== 0 || offset + length > contents.length) invalid();
        const chunk = contents.subarray(offset, offset + length);
        if (chunks === 0 && type === 0x4e4f534a) json = chunk;
        else if (chunks === 1 && type === 0x004e4942) binary = chunk;
        else invalid();
        offset += length;
        chunks++;
      }
    }
    let model: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(json.toString('utf8'));
      if (!object(parsed)) throw new Error('expected an object');
      model = parsed;
    } catch {
      reject(
        RenderCode.Asset,
        'src',
        'The glTF JSON is malformed.',
        'Export a valid glTF 2.0 JSON document.',
      );
    }
    if (
      !object(model.asset) ||
      model.asset.version !== '2.0' ||
      (model.asset.minVersion !== undefined && model.asset.minVersion !== '2.0')
    )
      reject(
        RenderCode.Unsupported,
        'asset.version',
        'Only glTF 2.0 is supported.',
        'Export an uncompressed glTF 2.0 model.',
      );
    for (const field of ['extensionsRequired', 'extensionsUsed']) {
      const names = model[field] ?? [];
      if (!Array.isArray(names) || names.some((name) => typeof name !== 'string'))
        reject(
          RenderCode.Asset,
          field,
          'Expected an array of extension names.',
          'Re-export valid glTF extension declarations.',
        );
      for (const name of names as string[]) {
        if (
          DECODER_EXTENSIONS.has(name) ||
          (field === 'extensionsRequired' && !SUPPORTED_EXTENSIONS.has(name))
        )
          reject(
            RenderCode.Unsupported,
            field,
            `Extension "${name}" requires unsupported content or a decoder.`,
            'Export uncompressed buffers and PNG/JPEG/WebP images; no runtime decoder or CDN is installed.',
          );
      }
    }
    const queue: unknown[] = [model];
    while (queue.length > 0) {
      const value = queue.pop();
      if (Array.isArray(value)) {
        for (const item of value) queue.push(item);
      } else if (object(value)) {
        if (object(value.extensions))
          for (const name of Object.keys(value.extensions))
            if (DECODER_EXTENSIONS.has(name))
              reject(
                RenderCode.Unsupported,
                'extensions',
                `Extension "${name}" is not supported, even if not marked required.`,
                'Re-export this resource without compression or external decoders.',
              );
        for (const item of Object.values(value)) queue.push(item);
      }
    }
    const entries = (field: string): Record<string, unknown>[] => {
      const list = model[field] ?? [];
      if (!Array.isArray(list) || list.some((value) => !object(value)))
        reject(
          RenderCode.Asset,
          field,
          `Malformed glTF ${field}.`,
          'Export a glTF array of resource objects.',
        );
      return list as Record<string, unknown>[];
    };
    const dependency = (uri: unknown, kind: 'image' | 'buffer', field: string): Buffer => {
      if (typeof uri !== 'string')
        reject(
          RenderCode.Asset,
          field,
          'Expected a resource URI.',
          'Name a local relative file or an embedded data URI.',
        );
      if (uri.startsWith('data:')) return embedded(uri, kind, field);
      if (!portablePath(uri))
        reject(
          RenderCode.Path,
          field,
          `Resource URI "${uri}" is not a local portable path.`,
          'Keep dependencies beside the model without remote URLs, traversal, encoding, queries, or fragments.',
        );
      const path = posix.join(posix.dirname(asset.src), uri);
      const bytes = read(path, field);
      if (kind === 'image' || extname(path).toLowerCase() === '.svg')
        image(bytes, IMAGE_MIME[extname(path).toLowerCase()] ?? extname(path), field);
      return bytes;
    };
    const buffers = entries('buffers').map((buffer, i) => {
      const field = `buffers[${i}]`;
      if (!integer(buffer.byteLength, 1))
        reject(
          RenderCode.Asset,
          `${field}.byteLength`,
          'Buffer byteLength must be a positive integer.',
          'Export the actual buffer length.',
        );
      const bytes =
        buffer.uri === undefined && i === 0 && binary !== undefined
          ? binary
          : dependency(buffer.uri, 'buffer', `${field}.uri`);
      if (bytes.length < (buffer.byteLength as number))
        reject(
          RenderCode.Asset,
          field,
          'The buffer is shorter than its declared byteLength.',
          'Restore the complete buffer or re-export the model.',
        );
      return bytes.subarray(0, buffer.byteLength as number);
    });
    const views = entries('bufferViews');
    for (const [i, item] of entries('images').entries()) {
      const field = `images[${i}]`;
      if (item.uri !== undefined) {
        if (item.bufferView !== undefined)
          reject(
            RenderCode.Asset,
            field,
            'An image cannot have both uri and bufferView.',
            'Keep exactly one image source.',
          );
        dependency(item.uri, 'image', `${field}.uri`);
      } else {
        const view = integer(item.bufferView) ? views[item.bufferView] : undefined;
        const buffer =
          view !== undefined && integer(view.buffer) ? buffers[view.buffer] : undefined;
        if (
          view === undefined ||
          buffer === undefined ||
          !integer(view.byteOffset ?? 0) ||
          !integer(view.byteLength, 1) ||
          ((view.byteOffset as number | undefined) ?? 0) + view.byteLength > buffer.length ||
          typeof item.mimeType !== 'string'
        )
          reject(
            RenderCode.Asset,
            field,
            'The embedded image has an invalid bufferView or MIME type.',
            'Export an in-bounds image bufferView with a supported image MIME type.',
          );
        const offset = (view.byteOffset as number | undefined) ?? 0;
        image(
          buffer.subarray(offset, offset + (view.byteLength as number)),
          item.mimeType as string,
          field,
        );
      }
    }
  }
  return {
    manifest,
    files: [...inventory.values()]
      .map(({ file }) => file)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    totalBytes,
    ...notes,
  };
}

/** Refuse changed files or replaced symlinks rather than serving bytes outside the checked closure. */
export function readPreparedPresentationFile(file: PreparedPresentationFile): Buffer {
  let contents: Buffer;
  try {
    if (realpathSync(file.source) !== file.source || statSync(file.source).size !== file.bytes)
      throw new Error('changed file');
    contents = readFileSync(file.source);
    if (createHash('sha256').update(contents).digest('hex') !== file.sha256)
      throw new Error('changed contents');
  } catch {
    fail(
      RenderCode.Asset,
      'assets',
      `Prepared asset "${file.path}" changed or became unreadable after preflight.`,
      'Restart the dev server or rerun the export to validate the current asset files.',
    );
  }
  return contents;
}
