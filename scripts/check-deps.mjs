// @ts-check
/**
 * Dependency-boundary checker for the Aegis monorepo.
 *
 * Enforces the package DAG from docs/architecture.md and CHARTER principle 2
 * ("core must never depend on rendering"). Runs in `npm run lint` and CI, with
 * zero third-party dependencies so it can never be defeated by a proxy hiccup.
 *
 * Two layers of enforcement:
 *   1. package.json — declared `dependencies` must be a subset of the allow-list.
 *   2. source imports — no `.ts` file may import an `@aegis/*` package outside the
 *      allow-list (catches an import that was never declared as a dependency).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');

/**
 * Allowed `@aegis/*` dependencies per package. Anything not listed is forbidden.
 * Keep this in sync with the DAG in docs/architecture.md.
 */
const ALLOWED = {
  '@aegis/core': [],
  '@aegis/content': ['@aegis/core'],
  '@aegis/harness': ['@aegis/core', '@aegis/content'],
  '@aegis/mode-platformer': ['@aegis/core', '@aegis/content', '@aegis/harness'],
  '@aegis/mode-iso': ['@aegis/core', '@aegis/content', '@aegis/harness'],
  '@aegis/mode-fps': ['@aegis/core', '@aegis/content', '@aegis/harness'],
  '@aegis/render-three': [
    '@aegis/core',
    '@aegis/content',
    '@aegis/harness',
    '@aegis/mode-platformer',
    '@aegis/mode-iso',
    '@aegis/mode-fps',
  ],
  '@aegis/cli': [
    '@aegis/core',
    '@aegis/content',
    '@aegis/harness',
    '@aegis/mode-platformer',
    '@aegis/mode-iso',
    '@aegis/mode-fps',
    '@aegis/render-three',
  ],
};

/** Packages that are forbidden from having ANY runtime dependency at all. */
const ZERO_RUNTIME_DEP = new Set(['@aegis/core']);

const errors = [];

/** @param {string} dir */
function tsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const importRe = /(?:import|export)[\s\S]*?from\s*['"](@aegis\/[a-z-]+)['"]/g;
const requireRe = /require\(\s*['"](@aegis\/[a-z-]+)['"]\s*\)/g;

const pkgDirs = readdirSync(packagesDir).filter((d) =>
  statSync(join(packagesDir, d)).isDirectory(),
);

for (const pkgDir of pkgDirs) {
  const pkgPath = join(packagesDir, pkgDir, 'package.json');
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    errors.push(`Missing or invalid package.json: ${pkgPath}`);
    continue;
  }
  const name = pkg.name;
  const allow = ALLOWED[name];
  if (!allow) {
    errors.push(`Unknown package "${name}" — add it to ALLOWED in scripts/check-deps.mjs`);
    continue;
  }

  const runtimeDeps = Object.keys(pkg.dependencies ?? {});
  if (ZERO_RUNTIME_DEP.has(name) && runtimeDeps.length > 0) {
    errors.push(
      `${name} must have ZERO runtime dependencies (CHARTER principle 2), found: ${runtimeDeps.join(', ')}`,
    );
  }

  // 1. Declared @aegis deps must be within the allow-list.
  for (const dep of runtimeDeps) {
    if (dep.startsWith('@aegis/') && !allow.includes(dep)) {
      errors.push(
        `${name} declares forbidden dependency "${dep}" (allowed: [${allow.join(', ')}])`,
      );
    }
  }

  // 2. Source imports must be within the allow-list.
  const srcDir = join(packagesDir, pkgDir, 'src');
  let files = [];
  try {
    files = tsFiles(srcDir);
  } catch {
    /* no src yet */
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const re of [importRe, requireRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const imported = m[1];
        if (imported === name) continue;
        if (!allow.includes(imported)) {
          const rel = file
            .slice(root.length + 1)
            .split(sep)
            .join('/');
          errors.push(`${rel} imports "${imported}" which is not allowed for ${name}`);
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error('Dependency-boundary check FAILED:\n');
  for (const e of errors) console.error('  x ' + e);
  console.error(`\n${errors.length} violation(s). See docs/architecture.md for the package DAG.`);
  process.exit(1);
}
console.log(`Dependency-boundary check passed for ${pkgDirs.length} package(s).`);
