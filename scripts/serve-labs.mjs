import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { isMain, readJson, repositoryRoot } from './sdk-tools.mjs';
import { validateBase } from './build-labs.mjs';

const mime = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
};

/**
 * `consumer` mounts a local directory read-only at `<base>consumer/`, so the animation lab can
 * preview consumer rigs, clips, cutscenes, cue tracks and voices (ANIM-07).
 */
export async function serveLabs({
  directory,
  port = 0,
  allowRequest = () => true,
  consumer = undefined,
}) {
  const root = resolve(directory);
  const mounted = consumer ? resolve(consumer) : undefined;
  const { base } = readJson(join(root, 'build-report.json'));
  validateBase(base);
  const server = createServer(async (request, response) => {
    if (!allowRequest()) {
      response.writeHead(503).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith(base)) {
        response.writeHead(404).end();
        return;
      }
      const leaf = path.slice(base.length);
      const inConsumer = mounted !== undefined && leaf.startsWith('consumer/');
      const top = inConsumer ? mounted : root;
      const rest = inConsumer ? leaf.slice('consumer/'.length) : leaf;
      const full = resolve(top, rest.endsWith('/') || !rest ? rest + 'index.html' : rest);
      if (!full.startsWith(top + sep)) {
        response.writeHead(403).end();
        return;
      }
      const data = await readFile(full);
      response.writeHead(200, {
        'Content-Type': mime[full.split('.').pop()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'",
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error?.code === 'ENOENT' || error?.code === 'EISDIR' ? 404 : 400;
      response.writeHead(status).end();
    }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      done();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No preview address');
  return {
    url: `http://127.0.0.1:${address.port}${base}`,
    close: () =>
      new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let directory = join(repositoryRoot, 'out', 'labs');
  let port = 4318;
  let consumer;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir') directory = resolve(args[++i]);
    else if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--consumer') consumer = resolve(args[++i]);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const preview = await serveLabs({ directory, port, consumer });
  console.log(JSON.stringify({ url: preview.url, target: 'static-preview', pid: process.pid }));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await preview.close();
      process.exit(0);
    });
}
