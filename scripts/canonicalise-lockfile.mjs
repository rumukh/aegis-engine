// @ts-check
/**
 * Canonicalises `resolved` URLs in `package-lock.json` to the public npm registry.
 *
 * **Why this exists.** This machine installs through a corporate Azure Artifacts proxy
 * (ENVIRONMENT.md), so npm writes lockfile `resolved` URLs that point at internal hosts:
 *
 *     https://ms-feed-12.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/
 *       yocto-queue/-/yocto-queue-0.1.0.tgz
 *
 * `npm ci` fetches tarballs from those URLs *literally* — the registry setting only selects
 * where packument metadata comes from. A GitHub-hosted runner cannot reach them, so CI dies at
 * the install step no matter what registry the workflow configures. Measured, not assumed:
 * overriding the registry alone leaves 223 fetches pointed at `*.pkgs.visualstudio.com`, and
 * npm's own `replace-registry-host=always` does not help either — it swaps the origin and keeps
 * the feed's base path, producing a 404 (`npm ci` exit 1).
 *
 * **Why canonical URLs work in both places.** The feed serves the public registry under a feed
 * path, so everything after `.../npm/registry/` is already the canonical registry path and this
 * is a pure prefix swap — no name or version is reconstructed. Afterwards:
 *
 *   - on a GitHub runner the URLs are literally correct;
 *   - behind the proxy, npm's *default* `replace-registry-host=npmjs` rewrites exactly
 *     `registry.npmjs.org` to the configured registry, yielding
 *     `https://packagefeedproxy.microsoft.io/npm/yocto-queue/-/yocto-queue-0.1.0.tgz`.
 *
 * Both environments are then served by the same committed lockfile, which is the point: a
 * second lockfile, or a CI-only `.npmrc`, would be two things that drift.
 *
 * **When to run it.** After any `npm install` / `npm update` on a proxied machine, because npm
 * will have written feed URLs back into the lockfile. `test/lockfile-registry.test.ts` fails the
 * gate if you forget, and names this script in the failure message.
 *
 *   node scripts/canonicalise-lockfile.mjs           # report only, exit 1 if work is needed
 *   node scripts/canonicalise-lockfile.mjs --write    # rewrite in place
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'package-lock.json');

/**
 * Any npm registry feed hosted on Azure Artifacts, whose tarball paths are the canonical
 * registry paths under a feed prefix.
 */
const FEED_PREFIX =
  /^https:\/\/[^/]*\.pkgs\.visualstudio\.com\/[^/]+\/_packaging\/[^/]+\/npm\/registry\//;

/** The canonical public registry origin that `replace-registry-host=npmjs` recognises. */
const CANONICAL = 'https://registry.npmjs.org/';

/**
 * @param {Record<string, { resolved?: string }>} packages
 * @returns {{ rewritten: number; canonical: number; unmatched: string[] }}
 */
function canonicalise(packages) {
  let rewritten = 0;
  let canonical = 0;
  /** @type {string[]} */
  const unmatched = [];

  for (const [key, entry] of Object.entries(packages)) {
    // Workspace links have no `resolved`; `file:` and `link:` entries are not registry fetches.
    if (!entry.resolved || !/^https?:/.test(entry.resolved)) continue;
    if (entry.resolved.startsWith(CANONICAL)) {
      canonical++;
    } else if (FEED_PREFIX.test(entry.resolved)) {
      entry.resolved = entry.resolved.replace(FEED_PREFIX, CANONICAL);
      rewritten++;
    } else {
      // Deliberately not silently tolerated: an unrecognised host is a registry this script has
      // never seen, and guessing at its path layout is how a lockfile ends up quietly wrong.
      unmatched.push(`${key} -> ${entry.resolved}`);
    }
  }
  return { rewritten, canonical, unmatched };
}

const write = process.argv.includes('--write');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const { rewritten, canonical, unmatched } = canonicalise(lock.packages ?? {});

console.log(
  `canonical: ${canonical}  needing rewrite: ${rewritten}  unrecognised host: ${unmatched.length}`,
);
for (const u of unmatched) console.error(`  UNRECOGNISED ${u}`);

if (unmatched.length > 0) {
  console.error('\nRefusing to touch the lockfile while an unrecognised registry host is present.');
  process.exit(2);
}

if (write) {
  if (rewritten > 0) {
    // npm writes two-space indent and a trailing newline; matching it keeps the diff to exactly
    // the lines whose URL changed instead of reformatting the whole file.
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    console.log(`rewrote ${rewritten} resolved URL(s) in package-lock.json`);
  } else {
    console.log('nothing to do');
  }
} else if (rewritten > 0) {
  console.error(
    `\n${rewritten} resolved URL(s) still point at the corporate feed.` +
      '\nRun: node scripts/canonicalise-lockfile.mjs --write',
  );
  process.exit(1);
}
