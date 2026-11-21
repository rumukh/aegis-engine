/** Game-free resolution of the local modules used by browser hosts. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, normalize, resolve, sep } from 'node:path';

/** Use npm's package search path, not a monorepo layout or CJS resolution of an ESM-only export. */
export function installedPackageRoot(name: string): string {
  for (const base of createRequire(import.meta.url).resolve.paths(name) ?? []) {
    const dir = join(base, name);
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name)
      return realpathSync(dir);
  }
  throw new Error(
    `Cannot locate installed package "${name}". Install the renderer's dependencies before serving or exporting.`,
  );
}

/**
 * Resolve a `/vendor/...` path to a file on disk, or `undefined` if it escapes the allowed roots.
 * `/vendor/three/*` maps to the installed package; `/vendor/@aegis/<pkg>/*` to `packages/<pkg>`.
 */
export function resolveVendorPath(
  roots: string | ReadonlyMap<string, string>,
  urlPath: string,
): string | undefined {
  let relative: string;
  try {
    relative = decodeURIComponent(urlPath.replace(/^\/vendor\//, ''));
  } catch {
    return undefined;
  }
  if (relative === '' || relative.includes('\0')) return undefined;

  const parts = normalize(relative)
    .split(/[\\/]/)
    .filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return undefined;

  const name =
    parts[0] === 'three'
      ? 'three'
      : parts[0] === '@aegis' && parts[1] !== undefined
        ? `@aegis/${parts[1]}`
        : undefined;
  if (name === undefined) return undefined;
  const root =
    typeof roots === 'string'
      ? name === 'three'
        ? join(roots, 'node_modules', name)
        : join(roots, 'packages', parts[1]!)
      : roots.get(name);
  if (root === undefined) return undefined;
  const rest = parts.slice(name === 'three' ? 1 : 2);

  const target = resolve(root, ...rest);
  const rootWithSep = resolve(root) + sep;
  if (!target.startsWith(rootWithSep)) return undefined;
  if (!existsSync(target) || !statSync(target).isFile()) return undefined;
  return realpathSync(target).startsWith(realpathSync(root) + sep) ? target : undefined;
}
