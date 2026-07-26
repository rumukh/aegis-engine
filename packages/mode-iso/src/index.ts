/**
 * `@aegis/mode-iso` — isometric, grid-based click-to-move and real-time-with-cooldown combat:
 * components, deterministic pathfinding, the system pipeline, the camera rig and the 2:1
 * projection, exposed as an {@link isoPlugin}. Games compose {@link isoSystems} / {@link isoInit}
 * with their own semantic systems into a runnable plugin.
 * @packageDocumentation
 */
export * from './components.js';
export * from './events.js';
export * from './grid.js';
export * from './systems.js';
export * from './plugin.js';
