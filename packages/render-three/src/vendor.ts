/** Game-free resolution of the local modules used by browser hosts. */
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * Resolve a `/vendor/...` path to a file on disk, or `undefined` if it escapes the allowed roots.
 * `/vendor/three/*` maps to the installed package; `/vendor/@aegis/<pkg>/*` to `packages/<pkg>`.
 */
export function resolveVendorPath(repoRoot: string, urlPath: string): string | undefined {
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

  let root: string;
  let rest: string[];
  if (parts[0] === 'three') {
    root = join(repoRoot, 'node_modules', 'three');
    rest = parts.slice(1);
  } else if (parts[0] === '@aegis' && parts[1] !== undefined) {
    root = join(repoRoot, 'packages', parts[1]);
    rest = parts.slice(2);
  } else {
    return undefined;
  }

  const target = resolve(root, ...rest);
  const rootWithSep = resolve(root) + sep;
  if (!target.startsWith(rootWithSep)) return undefined;
  if (!existsSync(target) || !statSync(target).isFile()) return undefined;
  return target;
}
