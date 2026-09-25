import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { launchBrowser } from '../packages/render-three/src/browser.js';
import { closeOwnedBrowser } from '../packages/render-three/src/testing/browser-lifecycle.js';
import { verifyCharacter } from '../games/horror/assets/source/trellis-monster/verify-character.mjs';

it('loads the retained character, decodes PBR textures and verifies every animated frame without Blender or inference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-character-'));
  const browser = await launchBrowser({ viewport: { width: 1000, height: 1000 } });
  try {
    await verifyCharacter({
      asset: resolve(
        'games',
        'horror',
        'assets',
        'imported',
        'responder-trellis',
        'model',
        'responder.glb',
      ),
      out: join(root, 'proof'),
      browser,
    });
    const result = JSON.parse(readFileSync(join(root, 'proof', 'verification.json'), 'utf8')) as {
      status: string;
      error?: string;
      staticMutationRejected: boolean;
      checks: { ok: boolean }[];
      clips: {
        name: string;
        frames: unknown[];
        maxContactError: number;
        maxRootMotion: number;
        stretchedEdges: number;
      }[];
    };
    expect(result.status, result.error).toBe('passed-pending-visual-approval');
    expect(result.staticMutationRejected).toBe(true);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    expect(result.clips.map((clip) => [clip.name, clip.frames.length])).toEqual([
      ['Idle', 205],
      ['Stalk', 133],
      ['Search', 265],
      ['Lunge', 49],
    ]);
    for (const clip of result.clips) {
      expect(clip.maxContactError).toBeLessThan(0.003);
      expect(clip.maxRootMotion).toBeLessThan(0.00001);
      expect(clip.stretchedEdges).toBe(0);
    }
  } finally {
    await closeOwnedBrowser(browser);
    rmSync(browser.profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
