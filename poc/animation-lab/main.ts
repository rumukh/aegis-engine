/**
 * Animation lab: the local preview route for 2D puppets, clips, cutscenes and lip-sync (ANIM-07).
 *
 * Without parameters it shows the original placeholder fixture. With
 * `?manifest=consumer/manifest.json` it previews consumer files mounted by
 * `npm run preview:labs -- --consumer <directory>`; the manifest format is documented in
 * docs/api/animation.md ("Preview route").
 */
import { createNarration } from '@aegis/browser/audio';
import type { AudioPack } from '@aegis/browser/audio';
import { createStage } from '@aegis/browser/stage';
import type { StagePuppet, CutsceneController } from '@aegis/browser/stage';
import type {
  AnimationDiagnostic,
  AvatarComposition,
  CutsceneFile,
} from '@aegis/browser/animation';

interface PreviewManifest {
  /** Asset ID -> path relative to the manifest. */
  paths: Record<string, string>;
  documents: string[];
  images?: string[];
  audio?: AudioPack;
  cutscenes?: string[];
  avatars?: {
    species: string[];
    scarfColors: Record<string, string>;
    hats: string[];
    badge?: string;
  };
  background?: string;
  effects?: Record<string, { frame: string }>;
}

const FIXTURE: PreviewManifest = {
  paths: {},
  documents: [
    ...['fox', 'cat', 'rabbit', 'bear', 'hedgehog'].flatMap((s) => [
      `avatar.${s}.atlas`,
      `avatar.${s}`,
    ]),
    'acc.scarf.atlas',
    'acc.hats.atlas',
    'acc.scarf.long',
    'acc.hat.detective',
    'acc.hat.beret',
    'acc.hat.cap',
    'acc.badge',
    'wave',
    'nod',
    'hop.small',
    'startle',
    'think',
    'sway',
  ],
  images: ['bg.office.png', 'bg.office.warm.png'],
  audio: {
    id: 'lab-voice',
    revision: '1',
    assets: [{ id: 'babble', src: 'assets/lab.babble.wav' }],
    lines: [
      {
        id: 'lab.babble',
        asset: 'babble',
        caption: 'Ла-ла-ла: синтетическая реплика для проверки движения губ.',
        speaker: 'guide',
        cues: 'lab.babble.cues',
      },
      { id: 'lab.label', asset: 'babble', caption: 'Кнопка', kind: 'label' },
    ],
  },
  cutscenes: ['lab.intro'],
  avatars: {
    species: ['avatar.fox', 'avatar.cat', 'avatar.rabbit', 'avatar.bear', 'avatar.hedgehog'],
    scarfColors: {
      Красный: '#c8553d',
      Синий: '#2f6fb3',
      Зелёный: '#3f8f5a',
      Жёлтый: '#e2b33b',
      Фиолетовый: '#7b4fa8',
      Розовый: '#e07aa5',
    },
    hats: ['acc.hat.detective', 'acc.hat.beret', 'acc.hat.cap'],
    badge: 'acc.badge',
  },
  background: 'bg.office.png',
  effects: { sparkles: { frame: 'acc.hats.atlas#badge' } },
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function main(): Promise<void> {
  const app = document.querySelector<HTMLElement>('#app')!;
  const params = new URLSearchParams(location.search);
  const manifestPath = params.get('manifest');
  const base = new URL(manifestPath ?? './', location.href);
  const manifest: PreviewManifest = manifestPath
    ? ((await (await fetch(base.href, { credentials: 'same-origin' })).json()) as PreviewManifest)
    : FIXTURE;
  const resolve = (id: string): string =>
    manifest.paths[id] ?? `assets/${id}${/\.(png|webp|wav|mp3|json)$/.test(id) ? '' : '.json'}`;

  app.replaceChildren();
  app.className = 'aegis-child';
  const title = element('h1', {}, 'Лаборатория анимации');
  const host = element('div', { 'data-testid': 'stage', class: 'stage-host' });
  host.style.cssText = 'position:relative;width:100%;aspect-ratio:16/10;max-height:70vh;';
  const caption = element('p', { 'aria-live': 'polite', 'data-testid': 'caption' });
  const status = element('p', { 'data-testid': 'speech' });
  const diagnostics = element('ul', { 'data-testid': 'diagnostics' });
  const controls = element('form', { 'aria-label': 'Управление' });
  controls.addEventListener('submit', (event) => event.preventDefault());
  app.append(title, host, caption, status, controls, diagnostics);

  const narration = createNarration({
    baseUrl: base.href,
    onState: () => undefined,
    onCaption: (line) => {
      caption.textContent = line?.caption ?? '';
    },
  });
  if (manifest.audio) narration.registerPack(manifest.audio);
  const stage = createStage({
    host,
    baseUrl: base.href,
    resolve,
    narration,
    ...(manifest.audio ? { audioPackId: manifest.audio.id } : {}),
    ...(manifest.effects ? { effects: manifest.effects } : {}),
    cameraPresets: { close: { x: 1280, y: 1000, zoom: 1.5 } },
    reducedMotion: params.get('reducedMotion') === '1' ? true : 'system',
    seed: 'animation-lab',
  });
  const report = (items: readonly AnimationDiagnostic[]): void => {
    diagnostics.replaceChildren(
      ...items.map((d) =>
        element('li', {}, `${d.severity} ${d.code} ${d.source ?? ''} ${d.path}: ${d.message}`),
      ),
    );
  };
  const loaded = await stage.load({
    documents: manifest.documents,
    ...(manifest.images ? { images: manifest.images } : {}),
  });
  report(loaded.diagnostics);
  if (!loaded.ok) {
    status.textContent = 'Документы не прошли проверку.';
    return;
  }
  if (manifest.background) stage.setBackground(manifest.background);

  const avatars = manifest.avatars;
  const choose = (label: string, options: readonly [string, string][]): HTMLSelectElement => {
    const select = element('select', { 'aria-label': label });
    for (const [value, text] of options) select.append(element('option', { value }, text));
    controls.append(element('label', {}, label), select);
    return select;
  };
  const species = choose(
    'Животное',
    (avatars?.species ?? []).map((id) => [id, id]),
  );
  const scarf = choose(
    'Шарфик',
    Object.entries(avatars?.scarfColors ?? {}).map(([n, c]) => [c, n]),
  );
  const hat = choose('Шапка', [
    ['', 'Без шапки'],
    ...(avatars?.hats ?? []).map((id): [string, string] => [id, id]),
  ]);
  const badge = choose('Значок', [
    ['yes', 'Есть'],
    ['', 'Нет'],
  ]);
  let avatar: StagePuppet | undefined;
  const composition = (): AvatarComposition => ({
    rig: species.value,
    tints: { scarf: scarf.value },
    accessories: [
      { slot: 'scarf', rig: 'acc.scarf.long' },
      ...(hat.value ? [{ slot: 'hat', rig: hat.value }] : []),
      ...(badge.value && avatars?.badge ? [{ anchor: 'badge', rig: avatars.badge }] : []),
    ],
  });
  const rebuild = (): void => {
    avatar?.remove();
    if (!species.value) return;
    avatar = stage.puppet({
      ...composition(),
      id: 'avatar',
      at: { x: 1280, y: 1420 },
      behaviours: { breathe: {}, blink: {} },
    });
  };
  for (const select of [species, scarf, hat, badge]) select.addEventListener('change', rebuild);
  rebuild();

  const button = (label: string, action: () => unknown): HTMLButtonElement => {
    const node = element('button', { type: 'button' }, label);
    node.addEventListener('click', () => {
      void (async () => {
        try {
          await narration.unlock().catch(() => undefined);
          await action();
        } catch (error) {
          status.textContent = String(error);
        }
      })();
    });
    controls.append(node);
    return node;
  };
  for (const clip of ['wave', 'nod', 'think', 'startle'])
    button(`Клип: ${clip}`, () => avatar?.play(clip));
  button('Прыжок', () => avatar?.hop());
  button('Эмоция: радость', () => avatar?.emote('joy'));
  button('Сказать реплику', () => avatar?.speak({ packId: 'lab-voice', lineId: 'lab.babble' }));
  button('Озвучить подпись', () => narration.speakLabel('lab-voice', 'lab.label'));
  button('Пауза/продолжить звук', () =>
    narration.clock().status === 'paused' ? narration.resume() : narration.pause(),
  );
  button('Спокойная анимация', () => stage.setReducedMotion(!stage.reducedMotion()));
  button('Лампа уюта', () => {
    stage.setComfort(!stage.comfort());
    if (manifest.background === 'bg.office.png')
      stage.setBackground(stage.comfort() ? 'bg.office.warm.png' : 'bg.office.png', {
        type: 'crossfade',
        duration: 0.5,
      });
  });
  let cutscene: CutsceneController | undefined;
  for (const id of manifest.cutscenes ?? []) {
    const file = (await (await fetch(new URL(resolve(id), base).href)).json()) as CutsceneFile;
    button(`Ролик ${id}`, () => {
      avatar?.setVisible(false);
      cutscene?.dispose();
      cutscene = stage.cutscene(file, {
        avatar: composition(),
        onEvent: (event) => {
          status.textContent = `Ролик: ${event.type}`;
          if (event.type === 'completed' || event.type === 'skipped') avatar?.setVisible(true);
        },
      });
      cutscene.play();
    });
  }
  button('Дальше', () => cutscene?.next());
  button('Пропустить', () => cutscene?.skip());
  button('Повторить', () => cutscene?.replay());
  setInterval(() => {
    const speech = avatar?.speech();
    if (speech) status.dataset['mode'] = speech.mode;
  }, 250);
  app.removeAttribute('aria-busy');
}

void main();
