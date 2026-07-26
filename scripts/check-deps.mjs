// @ts-check
/**
 * Dependency-boundary checker for the Aegis monorepo.
 *
 * Enforces the package DAG from docs/architecture.md and CHARTER principle 2
 * ("core must never depend on rendering"). Runs in `npm run lint` and CI, with
 * zero third-party dependencies so it can never be defeated by a proxy hiccup.
 *
 * Three layers of enforcement:
 *   1. package.json — declared `dependencies` must be a subset of the allow-list.
 *   2. source imports — no `.ts` file may import an `@aegis/*` package outside the
 *      allow-list (catches an import that was never declared as a dependency).
 *   3. relative imports may not cross a workspace-project boundary. This is what keeps
 *      the engine from ever depending on a game: `games/*` may build on `packages/*`,
 *      but nothing under `packages/*` may reach into `games/*` — not by package name
 *      (rule 2) and not by climbing out with `../../../games/...` (rule 3).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace roots scanned for projects, in the order they are reported. */
const WORKSPACE_ROOTS = ['packages', 'games'];

/** Directories inside a project that are scanned for imports. */
const SCANNED_DIRS = ['src', 'test'];

/**
 * Allowed `@aegis/*` dependencies per package. Anything not listed is forbidden.
 * Keep this in sync with the DAG in docs/architecture.md.
 *
 * The `@aegis/game-*` entries are the PoC games under `games/*`: a game may depend on the
 * engine and on *its own* mode, and on nothing else — never on another mode, never on the
 * renderer or the CLI, and never on another game.
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
  '@aegis/game-platformer': [
    '@aegis/core',
    '@aegis/content',
    '@aegis/harness',
    '@aegis/mode-platformer',
  ],
  '@aegis/game-iso': ['@aegis/core', '@aegis/content', '@aegis/harness', '@aegis/mode-iso'],
  '@aegis/game-fps': ['@aegis/core', '@aegis/content', '@aegis/harness', '@aegis/mode-fps'],
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

/** Repo-relative, forward-slashed path for error messages. @param {string} file */
function rel(file) {
  return relative(root, file).split(sep).join('/');
}

/** Whether `target` lives inside `dir`. @param {string} dir @param {string} target */
function isInside(dir, target) {
  const r = relative(dir, target);
  return r !== '' && !r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r);
}

const importRe = /(?:import|export)[\s\S]*?from\s*['"](@aegis\/[a-z-]+)['"]/g;
const requireRe = /require\(\s*['"](@aegis\/[a-z-]+)['"]\s*\)/g;

/** Relative specifiers, however they are written. */
const relativeSpecifierRes = [
  /\bfrom\s*['"](\.[^'"]*)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
  /\bimport\s+['"](\.[^'"]*)['"]/g,
  /\brequire\(\s*['"](\.[^'"]*)['"]\s*\)/g,
];

/** Every workspace project, as `{ dir, workspace }`. */
const projects = [];
for (const workspace of WORKSPACE_ROOTS) {
  const workspaceDir = join(root, workspace);
  for (const entry of readdirSync(workspaceDir)) {
    const dir = join(workspaceDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    projects.push({ dir, workspace });
  }
}

const gamesDir = join(root, 'games');

for (const project of projects) {
  const pkgPath = join(project.dir, 'package.json');
  /** @type {any} */
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    errors.push(
      `Missing or invalid package.json: ${rel(pkgPath)} — every workspace project needs one`,
    );
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

  // 2 + 3. Import checks over the project's own TypeScript.
  /** @type {string[]} */
  const files = [];
  for (const scanned of SCANNED_DIRS) {
    try {
      files.push(...tsFiles(join(project.dir, scanned)));
    } catch {
      /* directory not present */
    }
  }

  for (const file of files) {
    const text = readFileSync(file, 'utf8');

    // 2. Imports by package name must be within the allow-list.
    for (const re of [importRe, requireRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const imported = m[1];
        if (imported === name) continue;
        if (!allow.includes(imported)) {
          errors.push(`${rel(file)} imports "${imported}" which is not allowed for ${name}`);
        }
      }
    }

    // 3. Relative imports must stay inside this project.
    for (const re of relativeSpecifierRes) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const target = resolve(dirname(file), m[1]);
        if (isInside(project.dir, target)) continue;
        errors.push(
          project.workspace === 'packages' && isInside(gamesDir, target)
            ? `${rel(file)} reaches into games/ ("${m[1]}") — the engine must NEVER depend on a game`
            : `${rel(file)} escapes its own project with a relative import ("${m[1]}") — ` +
                'depend on another project by package name instead',
        );
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
console.log(`Dependency-boundary check passed for ${projects.length} workspace project(s).`);
