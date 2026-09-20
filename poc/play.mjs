// Start the browser dev server for the four demo games:
//
//   npm run build
//   node poc/play.mjs
//
// Optional flags: --port <n> (default 5173), --host <iface> (default 127.0.0.1).
import { play } from '../packages/render-three/dist/play.js';
import { pocGames } from './poc-games.mjs';

await play(await pocGames());
