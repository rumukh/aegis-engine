/**
 * Internal utilities shared across `@aegis/core`.
 * @packageDocumentation
 */

/** Semantic version of the Aegis engine contracts. */
export const AEGIS_VERSION = '0.0.0';

/**
 * Throws a uniform "not implemented" error. Contract stubs call this so that the
 * type surface compiles and links while the behaviour is filled in by a later
 * implementation session. Never reachable in a shipped build.
 *
 * @param what - Short description of the unimplemented operation.
 * @throws Always.
 */
export function notImplemented(what: string): never {
  throw new Error(`[aegis] not implemented: ${what}`);
}
