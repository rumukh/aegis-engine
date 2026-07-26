/**
 * `@aegis/render-three` — the optional three.js render adapter and browser dev server.
 *
 * A pure consumer of world state: nothing in the simulation depends on it, and attaching it
 * changes no simulation result (CHARTER principle 2, ADR-0005). Import the adapters anywhere;
 * the dev server is Node-only because it hosts an HTTP server, so the browser client imports the
 * adapter modules directly rather than through this barrel.
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
export * from './catalog.js';
export * from './script-input.js';
export * from './pages.js';
export * from './dev-server.js';
export * from './play.js';
export * from './capture.js';
