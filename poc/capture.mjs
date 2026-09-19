// Screenshot proof that the four demo games render and respond to real input:
//
//   npm run build
//   node poc/capture.mjs
//
// Writes packages/render-three/screenshots/{platformer,iso,fps,horror}.png.
// Flags: --out <dir>, --headed (watch it happen in a visible window).
import { capture } from '../packages/render-three/dist/capture.js';
import { pocGames } from './poc-games.mjs';

await capture(await pocGames());
