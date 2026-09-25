import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { horrorPresentation } from '../poc/horror.mjs';
import {
  inspectCharacterGlb,
  parseCharacterGlb,
  verifyCharacterReceipt,
} from '../games/horror/assets/source/trellis-monster/inspect-character.mjs';

const base = join('games', 'horror', 'assets');
const packageRoot = join(base, 'imported', 'responder-trellis');
const sourceRoot = join(base, 'source', 'trellis-monster');
const bytes = readFileSync(join(packageRoot, 'model', 'responder.glb'));
const receipt = JSON.parse(readFileSync(join(packageRoot, 'import.json'), 'utf8'));
const recipe = JSON.parse(readFileSync(join(sourceRoot, 'recipe.json'), 'utf8'));
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function changedDocument(
  edit: (doc: ReturnType<typeof parseCharacterGlb>['document']) => void,
): Buffer {
  const { document: doc, binary } = parseCharacterGlb(bytes);
  edit(doc);
  const text = Buffer.from(JSON.stringify(doc));
  const json = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, binHeader, binary]);
}

describe('Cable Warden retained cooked character contract', () => {
  it('pins the measured accepted-for-review bytes independently of the recipe and import receipt', () => {
    expect(sha(bytes)).toBe('848b13514963215faabff6d93839b088dc24c39064184a399313a8dabef667b7');
    expect(bytes.length).toBe(5_334_140);
    const facts = inspectCharacterGlb(bytes);
    expect(facts.triangles).toBe(33_273);
    expect(facts.vertices).toBe(20_852);
    expect(facts.textures.map((t) => [t.name, t.width, t.height])).toEqual([
      ['normal', 1024, 1024],
      ['basecolor', 2048, 2048],
      ['roughness', 1024, 1024],
    ]);
    expect(() => verifyCharacterReceipt(bytes, receipt)).not.toThrow();
    const descriptor = readFileSync(join(packageRoot, 'asset.presentation.json'));
    expect(descriptor.length).toBe(receipt.descriptor.bytes);
    expect(sha(descriptor)).toBe(receipt.descriptor.sha256);
    expect(recipe.output.sha256).toBe(
      '848b13514963215faabff6d93839b088dc24c39064184a399313a8dabef667b7',
    );
    expect(recipe.animationContract.durations).toEqual({
      Idle: 3.4,
      Stalk: 2.2,
      Search: 4.4,
      Lunge: 0.8,
    });
    expect(recipe.animationContract.playbackRates).toEqual({
      patrol: 1.58125,
      movingSearch: 2.0625,
      chase: 3.64375,
    });
    expect(recipe.animationContract.warningTicks).toBe(48);
  });

  it('preserves pinned bytes through actual Git smudge filters, with a failing old-policy control', () => {
    const prefix = 'games/horror/assets/imported/responder-trellis';
    const pins = [
      {
        path: `${prefix}/asset.presentation.json`,
        size: 542,
        hash: '33adc0c1017cd6d9087a6476f7aec0d86f1b70d7c04e2b2174f3c124d0931328',
      },
      {
        path: `${prefix}/import.json`,
        size: 1034,
        hash: 'c93af4df456ee0244faee593aed94541d338ca32338ff8a95841d122316103ab',
      },
      {
        path: `${prefix}/model/responder.glb`,
        size: 5334140,
        hash: '848b13514963215faabff6d93839b088dc24c39064184a399313a8dabef667b7',
      },
      {
        path: 'games/horror/assets/source/trellis-monster/approved-concept.png',
        size: 1146037,
        hash: 'ce24c1411cde4d932774a827a5ba8bd6a8b92652a585e85c026497c309f80a8b',
      },
    ];
    const attributes = readFileSync('.gitattributes', 'utf8');
    const root = mkdtempSync(join(tmpdir(), 'aegis-import-checkout-'));
    const git = (args: string[], autocrlf = 'true'): Buffer =>
      execFileSync(
        'git',
        ['-c', `core.autocrlf=${autocrlf}`, '-c', 'core.attributesFile=', ...args],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 },
      );
    try {
      git(['init', '--quiet']);
      writeFileSync(join(root, '.gitattributes'), attributes);
      const source = 'games/horror/assets/source/trellis-monster/cook.py';
      for (const path of [...pins.map((pin) => pin.path), source]) {
        const target = join(root, ...path.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(join(...path.split('/'))));
      }
      const gltf = 'games/example/assets/imported/revision/model/mesh.gltf';
      mkdirSync(dirname(join(root, ...gltf.split('/'))), { recursive: true });
      const gltfBytes = Buffer.from('{\r\n  "asset": { "version": "2.0" }\r\n}\r\n');
      writeFileSync(join(root, ...gltf.split('/')), gltfBytes);
      writeFileSync(join(root, 'control.txt'), 'alpha\nbeta\n');
      git(['add', '--all']);
      for (const autocrlf of ['true', 'false']) {
        for (const pin of pins) {
          const filtered = git(['cat-file', '--filters', `:${pin.path}`], autocrlf);
          expect(filtered.length, pin.path).toBe(pin.size);
          expect(sha(filtered), pin.path).toBe(pin.hash);
        }
        expect(git(['cat-file', '--filters', `:${gltf}`], autocrlf)).toEqual(gltfBytes);
        const script = git(['cat-file', '--filters', `:${source}`], autocrlf).toString('utf8');
        expect(sha(script.replaceAll('\r\n', '\n'))).toBe(
          'da9167de9695af98ddbc2e11349137b8020750ada53ecbcdb05217a80846033e',
        );
      }
      expect(git(['cat-file', '--filters', ':control.txt']).toString('utf8')).toBe(
        'alpha\r\nbeta\r\n',
      );
      writeFileSync(
        join(root, '.gitattributes'),
        attributes.replace(/^games\/\*\/assets\/imported\/\*\* -text\r?$/m, ''),
      );
      git(['add', '--', '.gitattributes']);
      const broken = git(['cat-file', '--filters', `:${pins[0]!.path}`]);
      expect(broken.length).toBe(557);
      expect(sha(broken)).toBe('f0234ed18579a96b20251ef1b4b223576a0571a08ea759ae21c1bf0953d5cdb0');
      expect(sha(broken)).not.toBe(pins[0]!.hash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves source rights, human gates, the historical rollback asset and portable cooker fingerprint', () => {
    expect(sha(readFileSync(join(base, 'generated', 'responder.glb')))).toBe(
      'e26edcaa4cf3703a65190b0a93432c54cedea7525a18ce45cf77a81991c1e682',
    );
    expect(sha(readFileSync(join(sourceRoot, 'approved-concept.png')))).toBe(
      'ce24c1411cde4d932774a827a5ba8bd6a8b92652a585e85c026497c309f80a8b',
    );
    expect(sha(readFileSync(join(sourceRoot, 'cook.py'), 'utf8').replaceAll('\r\n', '\n'))).toBe(
      'da9167de9695af98ddbc2e11349137b8020750ada53ecbcdb05217a80846033e',
    );
    expect(recipe.cooking.scriptSha256).toBe(
      'da9167de9695af98ddbc2e11349137b8020750ada53ecbcdb05217a80846033e',
    );
    expect(recipe.output.importReceiptSha256).toBe(
      'c93af4df456ee0244faee593aed94541d338ca32338ff8a95841d122316103ab',
    );
    expect(recipe.licensing.wholeToolchainMit).toBe(false);
    expect(recipe.licensing.commercialOutputClearanceEstablished).toBe(false);
    expect(recipe.approvals.finalActualGame).toBe('approved-user-2026-09-25');
    const approval = JSON.parse(readFileSync(join(sourceRoot, 'approval.json'), 'utf8'));
    expect(approval.decision).toBe('approved-final-actual-game');
    expect(approval.cookedModelSha256).toBe(
      '848b13514963215faabff6d93839b088dc24c39064184a399313a8dabef667b7',
    );
    expect(approval.userQuote).toBe('Amazing! Get it in!');
    const models = horrorPresentation.manifest.assets?.filter((asset) => asset.id === 'responder');
    expect(models).toHaveLength(1);
    expect(models?.[0]?.src).toBe('imported/responder-trellis/model/responder.glb');
    expect(models?.[0]?.provenance.license).toContain('Research/evaluation');
    expect(
      horrorPresentation.manifest.assets?.some((asset) => asset.src === 'generated/responder.glb'),
    ).toBe(false);
  });

  it('refuses a missing required texture, required clip or skin instead of accepting a placeholder', () => {
    expect(() =>
      inspectCharacterGlb(
        changedDocument((doc) => {
          delete doc.materials[0].normalTexture;
        }),
      ),
    ).toThrow(/normal texture/);
    expect(() =>
      inspectCharacterGlb(
        changedDocument((doc) => {
          doc.animations = doc.animations.filter((clip: { name: string }) => clip.name !== 'Lunge');
        }),
      ),
    ).toThrow(/clip inventory/);
    expect(() =>
      inspectCharacterGlb(
        changedDocument((doc) => {
          doc.skins = [];
        }),
      ),
    ).toThrow(/real character skin/);
    expect(() =>
      inspectCharacterGlb(
        changedDocument((doc) => {
          for (const clip of doc.animations) clip.channels = [];
        }),
      ),
    ).toThrow();
  });

  it('refuses a stale receipt independently of structural GLB validation', () => {
    const stale = structuredClone(receipt);
    stale.files[0].sha256 = '0'.repeat(64);
    expect(() => verifyCharacterReceipt(bytes, stale)).toThrow(/Stale imported character receipt/);
    expect(() => inspectCharacterGlb(bytes)).not.toThrow();
  });
});
