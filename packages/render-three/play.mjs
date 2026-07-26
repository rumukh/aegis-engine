// Start the browser dev server for the three proof-of-concept games:
//
//   npm run build
//   node packages/render-three/play.mjs
//
// Optional flags: --port <n> (default 5173), --host <iface> (default 127.0.0.1).
import { play } from './dist/play.js';
import { pocGames } from './poc-games.mjs';

await play(await pocGames());
