/**
 * The lockfile must resolve from the public npm registry.
 *
 * This machine installs through a corporate Azure Artifacts proxy (ENVIRONMENT.md), and npm
 * writes `resolved` URLs pointing at that feed's internal hosts. `npm ci` fetches tarballs from
 * those URLs *literally* — the configured registry only selects where packument metadata comes
 * from — so a lockfile full of feed URLs cannot be installed anywhere outside the corporate
 * network, including on the GitHub-hosted runners the CI workflow uses.
 *
 * Canonical `https://registry.npmjs.org/` URLs work in **both** places, which is why this is the
 * invariant rather than a CI-only workaround: a runner fetches them literally, and behind the
 * proxy npm's default `replace-registry-host=npmjs` rewrites exactly that origin to the
 * configured registry. One committed lockfile, two environments, nothing to drift.
 *
 * **The drift this guards against is silent.** A developer running `npm install <pkg>` on a
 * proxied machine gets feed URLs written back into the lockfile with no warning, and everything
 * keeps working locally — the breakage only appears on a runner. `scripts/canonicalise-lockfile.mjs`
 * repairs it; this test is what makes anyone run it.
 *
 * Read as text rather than imported: `tsconfig.tests.json` does not set `allowJs`, so a test in
 * this directory cannot import `scripts/canonicalise-lockfile.mjs` or a `.json` outside a
 * package. Both are parsed here instead, with anti-vacuity floors so that a parse that silently
 * matched nothing cannot read as a pass.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

const CANONICAL = 'https://registry.npmjs.org/';

interface LockEntry {
  resolved?: string;
}

function lockEntries(): [string, LockEntry][] {
  const lock = JSON.parse(read('package-lock.json')) as {
    lockfileVersion?: number;
    packages?: Record<string, LockEntry>;
  };
  expect(lock.lockfileVersion, 'lockfile v3 is what the resolved-URL layout below assumes').toBe(3);
  return Object.entries(lock.packages ?? {});
}

/** Entries that are actually fetched from a registry, i.e. not workspace links. */
function registryEntries(): [string, string][] {
  return lockEntries()
    .filter(([, v]) => typeof v.resolved === 'string' && /^https?:/.test(v.resolved))
    .map(([k, v]) => [k, v.resolved as string]);
}

describe('package-lock.json resolves from the public registry', () => {
  it('has enough registry-resolved entries for the check below to mean anything', () => {
    // Anti-vacuity. If a future lockfile format moved `resolved` elsewhere, every assertion in
    // this file would pass over an empty list and report a clean bill of health.
    expect(registryEntries().length).toBeGreaterThan(150);
  });

  it('resolves every dependency from registry.npmjs.org', () => {
    const offenders = registryEntries()
      .filter(([, url]) => !url.startsWith(CANONICAL))
      .map(([name, url]) => `${name} -> ${url}`);

    expect(
      offenders,
      'Run: node scripts/canonicalise-lockfile.mjs --write\n' +
        '(npm install behind the corporate proxy rewrites these back to the feed host, and the ' +
        'result installs fine locally but cannot be installed on a GitHub runner.)',
    ).toEqual([]);
  });

  it('keeps the repair script the failure message names', () => {
    const script = read('scripts/canonicalise-lockfile.mjs');
    expect(script).toContain(CANONICAL);
    expect(script).toContain('--write');
  });
});

describe('the corporate proxy is still what local development uses', () => {
  it('keeps the committed .npmrc pinned at the proxy', () => {
    // The canonical lockfile is not a licence to point local installs at public npm, which is
    // blocked here (ENVIRONMENT.md). The two halves only work together.
    expect(read('.npmrc')).toContain('packagefeedproxy.microsoft.io');
  });

  it('selects the public registry for CI, where the proxy is unreachable', () => {
    const lines = read('.github/workflows/ci.yml').split('\n');

    // Asserted structurally rather than by string position. The first version of this test
    // compared `indexOf('NPM_CONFIG_REGISTRY')` with `indexOf('npm ci')` and failed, because
    // `npm ci` also occurs in the explanatory comment above the env block — a textual proxy for
    // YAML scope measures the comment as readily as the code.
    const envAt = lines.findIndex((l) => l === '    env:');
    expect(envAt, 'a job-level env: block').toBeGreaterThan(-1);
    expect(lines[envAt + 1]).toBe('      NPM_CONFIG_REGISTRY: https://registry.npmjs.org/');

    // Job level, not step level: it must reach npm invoked from inside `npm run verify` too,
    // and an env var outranks the committed project .npmrc in npm's config precedence.
    const stepsAt = lines.findIndex((l) => l === '    steps:');
    expect(stepsAt).toBeGreaterThan(envAt);
  });

  it('still runs the gate as a single step', () => {
    // docs/working-agreement.md §3: the workflow must not be able to drift from the gate people
    // run locally. Whatever the registry plumbing does, it must not fragment this.
    const ci = read('.github/workflows/ci.yml');
    const runs = [...ci.matchAll(/^\s*run: (.+)$/gm)].map((m) => (m[1] ?? '').trim());
    expect(runs.length, 'the run: steps were found at all').toBeGreaterThan(1);
    expect(runs).toContain('npm run verify');
    expect(
      runs.filter((r) => r.startsWith('npm run')),
      'exactly one gate invocation',
    ).toEqual(['npm run verify']);
  });
});
