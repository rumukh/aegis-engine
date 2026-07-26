/**
 * The browser dev-server contract: serve a scene in a real browser with live three.js
 * rendering, driven by the same deterministic simulation used headlessly.
 *
 * This is a developer convenience only — it is never part of a headless run or a gameplay
 * assertion. It runs the simulation in the page, applies an optional input script, and lets
 * the adapter draw. The server itself carries no game logic.
 * @packageDocumentation
 */
import { notImplemented } from '@aegis/core';
import type { GameMode } from '@aegis/core';

/** Options for {@link startDevServer}. */
export interface DevServerOptions {
  /** Path to the scene document to serve. */
  scene: string;
  /** The mode to render the scene in. */
  mode: GameMode;
  /** TCP port. Defaults to `5173`. */
  port?: number;
  /** Host interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** Optional input-script path to drive the scene live. */
  input?: string;
  /** Ticks per second for the in-page simulation. Defaults to the scene's rate. */
  tickRate?: number;
  /** Open a browser window on start. Defaults to `false`. */
  open?: boolean;
}

/** A running dev server. */
export interface DevServer {
  /** The URL the server is listening on. */
  readonly url: string;
  /** The port actually bound. */
  readonly port: number;
  /** Stop the server and release the port. */
  close(): Promise<void>;
}

/** Start the browser dev server. Resolves once it is listening. */
export function startDevServer(options: DevServerOptions): Promise<DevServer> {
  return notImplemented('startDevServer');
}
