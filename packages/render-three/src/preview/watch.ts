import { lstatSync, readlinkSync, realpathSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { PreviewCode, previewError } from './diagnostics.js';
import type { PreviewSourceOptions } from './source.js';

interface WatchTarget {
  directory: string;
  recursive: boolean;
  /** Nonrecursive watches observe only these immediate entries, never unrelated siblings. */
  children: Set<string>;
}

function missing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function realDirectory(path: string): string | undefined {
  const real = realPath(path);
  if (real === undefined) return undefined;
  try {
    return statSync(real).isDirectory() ? real : undefined;
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

function nameKey(name: string): string {
  return process.platform === 'win32' ? name.toLowerCase() : name;
}

/**
 * Native directory watches follow an inode/handle, not a junction's future target. Watch the
 * logical entry's parent too, and compute the current resolved roots after every preparation.
 */
function targets(options: PreviewSourceOptions): Map<string, WatchTarget> {
  const result = new Map<string, WatchTarget>();
  const add = (directory: string, recursive: boolean, child?: string): void => {
    const identity = statSync(directory, { bigint: true });
    const key = `${recursive ? 'recursive' : 'entry'}:${identity.dev}:${identity.ino}:${nameKey(directory)}`;
    const target = result.get(key) ?? { directory, recursive, children: new Set<string>() };
    if (child !== undefined) target.children.add(nameKey(child));
    result.set(key, target);
  };
  const parent = (entry: string): void => {
    let child = resolve(entry);
    for (;;) {
      const directory = dirname(child);
      if (directory === child) return;
      const real = realDirectory(directory);
      if (real !== undefined) {
        add(real, false, basename(child));
        return;
      }
      // A temporarily absent subtree is observed from its nearest existing parent.
      child = directory;
    }
  };
  const links = (path: string): void => {
    for (let at = resolve(path); ;) {
      try {
        if (lstatSync(at).isSymbolicLink()) {
          parent(at);
          parent(resolve(dirname(at), readlinkSync(at)));
        }
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const next = dirname(at);
      if (next === at) return;
      at = next;
    }
  };

  const source = resolve(options.source);
  const sourceReal = realPath(source);
  const logicalDirectory = dirname(source);
  const assetRoot =
    options.assetRoot ??
    (sourceReal !== undefined && extname(sourceReal).toLowerCase() !== '.json'
      ? dirname(sourceReal)
      : logicalDirectory);
  parent(source);
  parent(logicalDirectory);
  links(source);
  parent(assetRoot);
  links(assetRoot);
  const resolvedRoot = realDirectory(assetRoot);
  if (resolvedRoot !== undefined) {
    add(resolvedRoot, true);
    parent(resolvedRoot);
  }
  return result;
}

/** Small lifetime owner for native watches; it performs no asset loading or directory scans. */
export class AssetPreviewWatch {
  readonly #options: PreviewSourceOptions;
  readonly #changed: (path: string | null, binding: boolean) => void;
  readonly #failed: (error: unknown) => void;
  readonly #active = new Map<string, { target: WatchTarget; watcher: FSWatcher }>();
  #closed = false;

  constructor(
    options: PreviewSourceOptions,
    changed: (path: string | null, binding: boolean) => void,
    failed: (error: unknown) => void,
  ) {
    this.#options = options;
    this.#changed = changed;
    this.#failed = failed;
  }

  refresh(): void {
    if (this.#closed) return;
    const desired = targets(this.#options);
    const created: string[] = [];
    try {
      for (const [key, target] of desired) {
        const existing = this.#active.get(key);
        if (existing !== undefined) {
          existing.target = target;
          continue;
        }
        const watcher = watch(
          target.directory,
          { recursive: target.recursive },
          (_event, filename) => {
            if (this.#closed) return;
            const current = this.#active.get(key)?.target;
            if (current === undefined) return;
            const name = filename?.toString();
            if (
              !current.recursive &&
              name !== undefined &&
              !current.children.has(nameKey(name.split(/[\\/]/)[0] ?? ''))
            )
              return;
            this.#changed(
              name === undefined ? null : resolve(current.directory, name),
              !current.recursive,
            );
          },
        );
        this.#active.set(key, { target, watcher });
        created.push(key);
        watcher.on('error', (error) => {
          if (this.#active.get(key)?.watcher !== watcher) return;
          watcher.close();
          this.#active.delete(key);
          if (!this.#closed)
            this.#failed(
              previewError(
                PreviewCode.Input,
                'watch',
                `Cannot watch "${target.directory}": ${error.message}`,
                'Repair this local directory or its permissions, then reload to rebind its watch.',
              ),
            );
        });
      }
    } catch (error) {
      for (const key of created) {
        this.#active.get(key)?.watcher.close();
        this.#active.delete(key);
      }
      throw error;
    }
    // Install replacements before removing old handles, so a rebinding has no unwatched gap.
    for (const [key, active] of this.#active) {
      if (desired.has(key)) continue;
      active.watcher.close();
      this.#active.delete(key);
    }
  }

  close(): void {
    this.#closed = true;
    for (const active of this.#active.values()) active.watcher.close();
    this.#active.clear();
  }
}
