/**
 * `@aegis/render-three` — the optional three.js render adapters, plus the real-time plumbing that
 * lets a human drive the same deterministic simulation a script does.
 *
 * A pure consumer of world state: nothing in the simulation depends on it, and attaching it
 * changes no simulation result (CHARTER principle 2, ADR-0005).
 * @packageDocumentation
 */
export * from './adapter.js';
export * from './adapters/index.js';
export * from './adapters/platformer.js';
export * from './adapters/iso.js';
export * from './adapters/fps.js';
export * from './appearance.js';
export * from './primitives.js';
export * from './bindings.js';
export * from './protocol.js';
export * from './loop.js';
export * from './live-input.js';
export * from './session.js';
