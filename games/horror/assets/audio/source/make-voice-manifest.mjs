import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { argv } from 'node:process';
import { URL } from 'node:url';

const output = argv[2];
if (!output) throw new Error('Usage: node make-voice-manifest.mjs <output.json>');
const { lines } = JSON.parse(
  await readFile(new URL('./voice-lines.json', import.meta.url), 'utf8'),
);
const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const segments = lines.map((line) => {
  const station = line.speaker === 'Station';
  const voice = station ? 'en-US-JennyNeural' : 'en-US-GuyNeural';
  const phrase = escape(line.text).replaceAll('. ', '.<break time="200ms"/>');
  return {
    id: line.id,
    speaker: line.speaker,
    voice,
    text: line.text,
    ssml: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${voice}"><mstts:express-as style="${station ? 'calm' : 'sad'}" styledegree="${station ? '0.7' : '0.5'}"><prosody rate="${station ? '-5%' : '-10%'}" pitch="${station ? '-2%' : '-3%'}">${phrase}</prosody></mstts:express-as></voice></speak>`,
    max_duration_seconds: line.maxDurationSeconds,
    critical: true,
  };
});
await writeFile(
  resolve(output),
  `${JSON.stringify(
    {
      schema_version: '1.0',
      language: 'en-US',
      default_voice: 'en-US-JennyNeural',
      backend: { provider: 'azure-speech', preferred_region: 'eastus2' },
      quality: {
        min_accuracy: 90,
        min_fluency: 70,
        min_completeness: 90,
        min_target_word_accuracy: 90,
        max_fit_factor: 1.08,
      },
      segments,
    },
    null,
    2,
  )}\n`,
);
