// Screenshot proof that the three PoC games render and respond to real input:
//
//   npm run build
//   node poc/capture.mjs
//
// Writes packages/render-three/screenshots/{platformer,iso,fps}.png.
// Flags: --out <dir>, --headed (watch it happen in a visible window).
import { capture } from '../packages/render-three/dist/capture.js';
import { pocGames } from './poc-games.mjs';

await capture(await pocGames());
