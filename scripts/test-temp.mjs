import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  posix,
  win32,
} from 'node:path';

/**
 * @param {NodeJS.Platform} [platform]
 * @param {NodeJS.ProcessEnv} [environment]
 * @param {string} [systemTemp]
 */
export function selectTestTempRoot(
  platform = process.platform,
  environment = process.env,
  systemTemp = tmpdir(),
) {
  const paths = platform === 'win32' ? win32 : posix;
  const configured = environment.AEGIS_TEST_TMPDIR;
  if (configured !== undefined) {
    if (!paths.isAbsolute(configured))
      throw new Error('[test-run] AEGIS_TEST_TMPDIR must be an absolute directory path.');
    return { directory: configured, source: 'AEGIS_TEST_TMPDIR' };
  }
  if (platform === 'win32' && environment.LOCALAPPDATA !== undefined) {
    if (!paths.isAbsolute(environment.LOCALAPPDATA))
      throw new Error('[test-run] LOCALAPPDATA must be an absolute directory path.');
    return {
      directory: win32.join(environment.LOCALAPPDATA, 'Aegis', 'test-tmp'),
      source: 'Windows local application data',
    };
  }
  return { directory: systemTemp, source: 'system temporary directory' };
}

/** @param {string} directory @returns {string} */
function canonicalDestination(directory) {
  try {
    return realpathSync(directory);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(directory);
    if (parent === directory) throw error;
    return join(canonicalDestination(parent), basename(directory));
  }
}

/**
 * Every run owns one fresh directory; only its children receive the temporary-path overrides.
 * @param {string} workspaceRoot
 * @param {NodeJS.ProcessEnv} [environment]
 */
export function createTestTemp(workspaceRoot, environment = process.env) {
  const selection = selectTestTempRoot(process.platform, environment);
  const base = canonicalDestination(resolve(selection.directory));
  const fromWorkspace = relative(realpathSync(resolve(workspaceRoot)), base);
  if (
    fromWorkspace === '' ||
    (!isAbsolute(fromWorkspace) && fromWorkspace !== '..' && !fromWorkspace.startsWith(`..${sep}`))
  )
    throw new Error(
      '[test-run] Temporary files must be outside the checkout so standalone consumers cannot inherit workspace dependencies.',
    );
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'aegis-test-'));
  const childEnvironment = { ...environment };
  if (process.platform === 'win32') {
    for (const key of Object.keys(childEnvironment)) {
      if (['TEMP', 'TMP', 'TMPDIR'].includes(key.toUpperCase())) delete childEnvironment[key];
    }
  }
  Object.assign(childEnvironment, { TEMP: directory, TMP: directory, TMPDIR: directory });
  return {
    directory,
    source: selection.source,
    environment: childEnvironment,
    dispose() {
      rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

/** @param {{dispose(): void}} temporary */
export function installTestTempCleanup(temporary) {
  process.once('exit', () => {
    try {
      temporary.dispose();
    } catch (error) {
      process.stderr.write(
        `[test-run] REFUSED: temporary-directory cleanup failed: ${String(error)}\n`,
      );
      process.exitCode = 1;
    }
  });
}
