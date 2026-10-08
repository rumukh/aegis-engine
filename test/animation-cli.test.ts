import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { repositoryRoot } from '../scripts/sdk-tools.mjs';
import { generateFixture } from '../poc/animation-lab/fixture.mjs';

const cli = join(repositoryRoot, 'packages', 'browser', 'bin', 'aegis-animation.mjs');
const directory = mkdtempSync(join(tmpdir(), 'aegis-animation-cli-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function validate(...args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, 'validate', ...args]);
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { code: number; stdout: string };
    return { code: failure.code, stdout: failure.stdout };
  }
}

describe('aegis-animation CLI (ANIM-07)', () => {
  it('validates the reference fixture, raw Rhubarb cue files, and reports broken rigs', async () => {
    for (const [name, bytes] of generateFixture().files)
      if (name.endsWith('.json')) writeFileSync(join(directory, name), bytes);
    writeFileSync(
      join(directory, 'P1-02.0123abcd89.cues.json'),
      JSON.stringify({
        metadata: { soundFile: 'P1-02.mp3', duration: 1.2 },
        mouthCues: [
          { start: 0, end: 0.3, value: 'X' },
          { start: 0.3, end: 1.2, value: 'D' },
        ],
      }),
    );
    writeFileSync(join(directory, 'durations.json'), JSON.stringify({ 'P1-02': 1.5 }));
    const ok = await validate(directory, '--durations', join(directory, 'durations.json'));
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('2 aegis-cues/1');
    // The duration map is keyed by line: the Rhubarb file named its line without the hash.
    expect(ok.stdout).toContain('warning AEG-ANIM-0031');
    writeFileSync(
      join(directory, 'broken.rig.json'),
      JSON.stringify({
        format: 'aegis-rig/1',
        id: 'broken',
        revision: '1',
        atlases: [],
        parts: [],
      }),
    );
    const broken = await validate(directory);
    expect(broken.code).toBe(2);
    expect(broken.stdout).toContain('error AEG-ANIM-0003');
  }, 60_000);
});
