/**
 * "Coyote Gap" — the PoC platformer game built on `@aegis/mode-platformer`. Exposes the composed
 * {@link coyoteGapPlugin}, the game's components/events and its systems, so the acceptance test
 * (and any tooling) can drive a run without reaching into individual modules.
 * @packageDocumentation
 */
export * from './components.js';
export * from './events.js';
export * from './systems.js';
export * from './plugin.js';
