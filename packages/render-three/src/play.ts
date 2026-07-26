/**
 * The dev-server entry point: `node packages/render-three/play.mjs`.
 *
 * Loads the three PoC games' **composed** plugins and scenes, serves them, and prints the URLs.
 * Nothing here is part of a headless run or a gameplay assertion — this is the human's door.
 * @packageDocumentation
 */
import { loadPocGames } from './games.js';
import { startDevServer } from './dev-server.js';

/** Read `--flag value` / `--flag=value` from `argv`. */
function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === prefix) return argv[i + 1];
    if (arg !== undefined && arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
  }
  return undefined;
}

/** Start the server and report where it is. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const portArg = flag(argv, 'port');
  const games = await loadPocGames();
  const server = await startDevServer({
    games,
    ...(portArg !== undefined ? { port: Number(portArg) } : {}),
    ...(flag(argv, 'host') !== undefined ? { host: flag(argv, 'host') as string } : {}),
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

await main();
