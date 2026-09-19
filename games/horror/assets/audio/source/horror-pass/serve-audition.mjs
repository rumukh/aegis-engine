import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { argv, stdout, stderr } from 'node:process';
import { URL } from 'node:url';
import { sha256 } from '../audio-tools.mjs';

const [directory] = argv.slice(2);
if (!directory) throw new Error('Usage: node serve-audition.mjs <immutable-audition-directory>');
const root = resolve(directory);
const raw = await readFile(join(root, 'audition.json'), 'utf8');
const manifest = JSON.parse(raw);
const items = [...manifest.cues, { id: 'context-38s', ...manifest.mix }];
for (const item of items) {
  if ((await sha256(join(root, item.file))) !== item.sha256)
    throw new Error(`Changed audition file ${item.id}`);
}
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Null Meridian | Horror sound audition</title><style>
body{font:16px/1.6 system-ui;background:#0b1417;color:#e0e7e5;max-width:900px;padding:30px;margin:auto}h1{letter-spacing:.1em;font-size:30px}article{background:#19272b;border:1px solid #43595e;padding:22px;margin:22px 0;border-radius:8px}audio{width:100%}.gate{color:#e6bd83}small{color:#acc1c5;overflow-wrap:anywhere}h2{font-size:20px}
</style><h1>NULL MERIDIAN</h1><p class="gate">NEW HORROR SOUND AUDITION / HUMAN APPROVAL PENDING</p>
<p>Three original nonmusical candidates, then a38-second contextual assembly with space between sounds. Start at low headphone volume. No autoplay. Isolated files are louder than their proposed in-game gain; the contextual assembly applies0.65 master headroom once.</p>
<p>Baseline voices and real hostile footsteps/windup/catch cues are unchanged. These are material motion, tiny organic clicks, and damaged suit respiration—not footsteps, intelligible speech, a score, or damage warnings.</p>
${items.map((item) => `<article><h2>${escape(item.id)}</h2><p>${escape(item.description ?? 'Context: room tone; membrane at5s; unchanged crew recording at11s; quiet chitter at14.3s deliberately overlaps the clue for masking review; damaged responder breath at29s. Long quiet intervals separate the other gestures.')}</p><audio controls preload="metadata" src="/media/${encodeURIComponent(item.id)}"></audio><p>${item.durationSeconds.toFixed(3)}s · ${item.metrics.integratedLufs}LUFS · ${item.metrics.truePeakDbtp}dBTP${item.proposedLayerGain ? ` · proposed layer gain${item.proposedLayerGain}` : ''}</p><small>SHA256 ${item.sha256}</small></article>`).join('')}
<p class="gate">Please judge unease, restraint, physical credibility, and whether the responder sounds damaged rather than theatrical. This gate approves or revises sound direction, not final loops or game spatial behavior.</p>
<p><small>The context uses fixed equal-power pan, not game HRTF or distance attenuation. The14.3s overlap is a listening test, not a new dialogue-event trigger. Real runtime overlap, pause/restart, masking and warning protection still require integrator proof and listening.</small></p></html>`);
      return;
    }
    if (url.pathname === '/manifest.json') {
      response
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(raw);
      return;
    }
    const item = items.find((candidate) => url.pathname === `/media/${candidate.id}`);
    if (!item) {
      response.writeHead(404).end('Not found');
      return;
    }
    const path = join(root, item.file);
    const info = await stat(path);
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : info.size - 1;
    if (start > end || end >= info.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      'Content-Type': path.endsWith('.ogg') ? 'audio/ogg' : 'audio/flac',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
    });
    createReadStream(path, { start, end }).pipe(response);
  } catch (error) {
    stderr.write(`${error.stack}\n`);
    if (!response.headersSent) response.writeHead(500);
    response.end('Audition file unavailable; owned server log contains the error.');
  }
});
server.listen(0, '127.0.0.1', () => {
  stdout.write(`HORROR_AUDITION_URL=http://127.0.0.1:${server.address().port}/\n`);
});
