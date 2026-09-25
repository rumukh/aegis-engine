import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
