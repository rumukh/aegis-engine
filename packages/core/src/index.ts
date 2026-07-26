/**
 * `@aegis/core` — the deterministic ECS substrate.
 *
 * Zero runtime dependencies; runs headless in Node with no DOM (CHARTER principle 2).
 * This barrel is the entire public surface of the package. The deterministic math surface
 * is also available at the `@aegis/core/math` subpath.
 * @packageDocumentation
 */
export * from './util.js';
export * from './modes.js';
export * from './entity.js';
export * from './component.js';
export * from './components.js';
export * from './query.js';
export * from './events.js';
export * from './input.js';
export * from './prng.js';
export * from './diagnostics.js';
export * from './serialize.js';
export * from './hash.js';
export * from './world.js';
export * from './scheduler.js';
export * from './math/index.js';
