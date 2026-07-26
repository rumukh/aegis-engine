/**
 * The dev-server entry point. Game-agnostic: it serves whatever catalogue it is handed.
 *
 * The three PoC games are wired up by `packages/render-three/poc-games.mjs`, which is the
 * composition root — the renderer is engine and may not depend on a game (see `./catalog.ts`).
 * @packageDocumentation
 */
import { startDevServer } from './dev-server.js';
import type { GameDefinition } from './catalog.js';

/** Read `--flag value` / `--flag=value` from `argv`. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === prefix) return argv[i + 1];
    if (arg !== undefined && arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
  }
  return undefined;
}

/** Start the server for `games` and report where it is. */
export async function play(
  games: readonly GameDefinition[],
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const port = flag(argv, 'port');
  const host = flag(argv, 'host');
  const server = await startDevServer({
    games,
    ...(port !== undefined ? { port: Number(port) } : {}),
    ...(host !== undefined ? { host } : {}),
  });

  console.log(`\n  Aegis dev server  ${server.url}\n`);
  for (const game of games) {
    console.log(
      `    ${game.mode.padEnd(11)} ${game.title.padEnd(18)} ${server.url}/play/${game.id}`,
    );
  }
  console.log('\n  Ctrl+C to stop.\n');

  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
