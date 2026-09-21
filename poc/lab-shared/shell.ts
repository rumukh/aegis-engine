import { createNarration } from '@aegis/browser/audio';
import {
  applyPresentationPreferences,
  bindVisibilityPause,
  createActionButton,
  createMessages,
  isPresentationPreferences,
  openDialog,
} from '@aegis/browser/ui';
import type { PresentationPreferences } from '@aegis/browser/ui';
import { createInstallationRequest, OfflinePackStore } from '@aegis/browser/offline';
import { registerOfflineWorker } from '@aegis/browser/offline/worker';
import type { OfflinePack } from '@aegis/browser/offline';
import type { RuntimeHost } from '@aegis/runtime';
import { english, russian } from './catalogs.js';
import { createCommandController } from './commands.js';

export const defaultPreferences: PresentationPreferences = {
  locale: 'ru',
  textScale: 1,
  reducedMotion: false,
  comfort: false,
  hideSpoilers: false,
  volumes: { narration: 1, music: 0.5, effects: 0.5 },
};

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ShellPersistence {
  preferences: PresentationPreferences;
  savePreferences(value: PresentationPreferences): Promise<void>;
  exportBackup(): Promise<string>;
  importBackup(text: string): Promise<void>;
  reset(): Promise<void>;
  load(): Promise<void>;
}
class PreferencePersistenceError extends Error {}

export function createShell<S, A, V, C>(
  host: RuntimeHost<S, A, V, C>,
  gameId: string,
  title: string,
  persistence: ShellPersistence,
) {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) throw new Error('Missing application root');
  const basePath = document.querySelector<HTMLMetaElement>('meta[name="aegis-base"]')?.content;
  if (!basePath) throw new Error('Missing application base path');
  const packRevision = document.querySelector<HTMLMetaElement>(
    'meta[name="aegis-pack-revision"]',
  )?.content;
  if (!packRevision) throw new Error('Missing installed pack identity');
  const baseUrl = new URL(basePath, location.origin).href;
  let preferences = persistence.preferences;
  let message = createMessages(preferences.locale === 'ru' ? russian : english);
  const root = element('main');
  const heading = element('h1');
  const navigation = element('nav');
  const controls = element('div');
  controls.className = 'controls';
  const content = element('section');
  const status = element('p');
  status.setAttribute('role', 'status');
  status.dataset.testid = 'status';
  const saveStatus = element('p');
  saveStatus.setAttribute('role', 'status');
  saveStatus.dataset.testid = 'save-status';
  const caption = element('p');
  caption.className = 'caption';
  caption.dataset.testid = 'caption';
  const voiceStatus = element('p');
  voiceStatus.dataset.testid = 'voice-status';
  const offlineStatus = element('p');
  offlineStatus.dataset.testid = 'offline-status';
  let render = (): void => {};
  let lineId = 'lab.welcome';
  let voiceReady = false;
  const fail = (cause: unknown): void => {
    status.textContent = message(
      cause instanceof PreferencePersistenceError ? 'preferencesFailure' : 'error',
    );
  };
  const commands = createCommandController(host, fail);
  const narration = createNarration({
    baseUrl,
    onState: (state) => {
      voiceStatus.dataset.status = state.status;
      voiceStatus.dataset.offset = String(state.offset);
      voiceStatus.dataset.voices = String(state.voices);
      voiceStatus.dataset.decodedBytes = String(state.decodedBytes);
      if (state.status === 'failed') voiceStatus.textContent = message('audioFailed');
      if (state.status === 'blocked') voiceStatus.textContent = message('audioBlocked');
    },
    onCaption: (line) => {
      caption.textContent = line?.caption ?? '';
    },
  });
  const samples = ['lab.welcome', 'lab.clue', 'lab.complete'] as const;
  narration.registerPack({
    id: 'lab-samples',
    revision: 'ru-dmitry-1',
    assets: samples.map((id) => ({ id, src: `assets/${id}.wav` })),
    lines: samples.map((id) => ({ id, asset: id, caption: russian[id] })),
  });
  narration.registerPack({
    id: 'lab-atmosphere',
    revision: 'pulses-1',
    assets: [
      { id: 'slow', src: 'assets/atmosphere-slow.wav' },
      { id: 'fast', src: 'assets/atmosphere-fast.wav' },
    ],
    lines: [],
  });
  let desiredAtmosphere: 'slow' | 'fast' | null = null;
  let ambienceEnabled = false;
  voiceReady = true;
  const offline = new OfflinePackStore({ namespace: 'aegis-reference-labs', baseUrl });
  const button = (
    key: string,
    action: () => void | Promise<void>,
    testId = key,
  ): HTMLButtonElement => {
    const node = createActionButton({
      document,
      label: message(key),
      command: action,
      onError: fail,
    });
    node.dataset.testid = testId;
    return node;
  };
  const apply = (): void => {
    applyPresentationPreferences(document.documentElement, preferences);
    document.body.classList.toggle('comfort', preferences.comfort);
    document.body.classList.toggle('reduced-motion', preferences.reducedMotion);
    for (const bus of ['narration', 'music', 'effects'] as const)
      narration.setVolume(bus, preferences.volumes[bus]);
  };
  const updatePreferences = async (): Promise<void> => {
    if (!isPresentationPreferences(preferences)) throw new Error('Invalid preference state');
    const localeChanged = document.documentElement.lang !== preferences.locale;
    message = createMessages(preferences.locale === 'ru' ? russian : english);
    if (preferences.hideSpoilers) {
      narration.clear();
      caption.textContent = '';
      status.textContent = '';
    }
    apply();
    if (localeChanged) chrome();
    render();
    try {
      await persistence.savePreferences(structuredClone(preferences));
    } catch (cause) {
      status.textContent = message('preferencesFailure');
      throw new PreferencePersistenceError('Preference persistence failed', { cause });
    }
  };
  const dialog = (label: string, fill: (body: HTMLDialogElement) => void): void => {
    const node = element('dialog');
    node.setAttribute('aria-label', message(label));
    fill(node);
    node.append(button('close', () => node.close()));
    root.append(node);
    node.addEventListener('close', () => node.remove(), { once: true });
    openDialog(node, node.querySelector<HTMLElement>('button') ?? undefined, heading);
  };
  const settings = (): void =>
    dialog('settings', (body) => {
      const language = element('select');
      for (const [value, key] of [
        ['ru', 'russian'],
        ['en', 'english'],
      ]) {
        const option = element('option', message(key!));
        option.value = value!;
        option.selected = preferences.locale === value;
        language.append(option);
      }
      const languageLabel = element('label', message('language'));
      languageLabel.append(language);
      body.append(languageLabel);
      language.addEventListener('change', () => {
        preferences = { ...preferences, locale: language.value };
        void updatePreferences().catch(fail);
      });
      const toggles = [
        [
          'largeText',
          preferences.textScale === 2,
          (checked: boolean) => {
            preferences.textScale = checked ? 2 : 1;
          },
        ],
        [
          'comfort',
          preferences.comfort,
          (checked: boolean) => {
            preferences.comfort = checked;
          },
        ],
        [
          'reducedMotion',
          preferences.reducedMotion,
          (checked: boolean) => {
            preferences.reducedMotion = checked;
          },
        ],
        [
          'spoiler',
          preferences.hideSpoilers,
          (checked: boolean) => {
            preferences.hideSpoilers = checked;
          },
        ],
      ] as const;
      for (const [key, checked, change] of toggles) {
        const label = element('label', message(key));
        const input = element('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.dataset.testid = key;
        input.addEventListener('change', () => {
          change(input.checked);
          void updatePreferences().catch(fail);
        });
        label.append(input);
        body.append(label);
      }
      for (const bus of ['narration', 'music', 'effects'] as const) {
        const label = element('label', message(bus + 'Volume'));
        const input = element('input');
        input.type = 'range';
        input.min = '0';
        input.max = '1';
        input.step = '.1';
        input.value = String(preferences.volumes[bus]);
        input.addEventListener('change', () => {
          preferences.volumes[bus] = Number(input.value);
          void updatePreferences().catch(fail);
        });
        label.append(input);
        body.append(label);
      }
      body.append(
        button('export', async () => {
          const url = URL.createObjectURL(
            new Blob([await persistence.exportBackup()], { type: 'application/json' }),
          );
          const anchor = element('a');
          anchor.href = url;
          anchor.download = gameId + '.json';
          anchor.click();
          URL.revokeObjectURL(url);
        }),
      );
      const file = element('input');
      file.type = 'file';
      file.accept = 'application/json';
      const label = element('label', message('import'));
      label.append(file);
      body.append(label);
      file.addEventListener('change', () => {
        const selected = file.files?.[0];
        if (selected)
          void selected
            .text()
            .then((text) => persistence.importBackup(text))
            .catch(fail);
      });
      body.append(
        button('reset', () => {
          dialog('reset', (confirmation) => {
            confirmation.append(
              element('p', message('resetWarning')),
              button('confirmReset', async () => {
                await persistence.reset();
                location.reload();
              }),
              button('cancel', () => confirmation.close()),
            );
          });
        }),
      );
    });
  const chrome = (): void => {
    heading.textContent = message(title);
    heading.tabIndex = -1;
    navigation.replaceChildren();
    for (const [path, key] of [
      ['storybook-lab/', 'storyLink'],
      ['turn-kitchen-lab/', 'kitchenLink'],
    ]) {
      const link = element('a', message(key!));
      link.href = new URL(path!, baseUrl).href;
      navigation.append(link);
    }
    controls.replaceChildren(
      button('pause', () => host.pause('user')),
      button('resume', async () => {
        await commands.resume('user');
        if (!host.getStatus().pauseReasons.length) await narration.resume();
      }),
      button('replay', async () => {
        caption.textContent = message(lineId);
        if (!voiceReady || preferences.locale !== 'ru') {
          voiceStatus.textContent = message('voiceMissing');
          return;
        }
        await narration.unlock();
        await narration.playLine('lab-samples', lineId);
      }),
      button('ambience', async () => {
        ambienceEnabled = true;
        await narration.unlock();
        if (desiredAtmosphere)
          await narration.setAtmosphere({
            packId: 'lab-atmosphere',
            asset: desiredAtmosphere,
            fadeSeconds: 0.25,
          });
      }),
      button('silence', async () => {
        ambienceEnabled = false;
        await narration.setAtmosphere(null);
      }),
      button('settings', settings),
      button('help', () =>
        dialog('help', (body) => body.append(element('p', message('helpText')))),
      ),
      button('retry', async () => {
        await commands.retry();
      }),
      button('load', () => persistence.load()),
      button('offline', async () => {
        delete offlineStatus.dataset.error;
        offlineStatus.textContent = message('offlineInstalling');
        try {
          const response = await fetch(createInstallationRequest('resource-graph.json', baseUrl));
          if (!response.ok) throw new Error('Offline resource graph unavailable');
          const pack: OfflinePack = await response.json();
          if (pack.id !== 'aegis-reference-labs')
            throw new Error('Unexpected reference pack identity');
          await offline.install(pack);
          await registerOfflineWorker('worker.js', baseUrl);
          offlineStatus.textContent = message('offlineReady');
        } catch (cause) {
          offlineStatus.textContent = message('offlineFailed');
          offlineStatus.dataset.error = cause instanceof Error ? cause.message : 'unknown';
          throw cause;
        }
      }),
    );
    voiceStatus.textContent = message(voiceReady ? 'voiceScope' : 'voiceMissing');
    caption.textContent = message(lineId);
  };
  root.append(
    heading,
    navigation,
    controls,
    saveStatus,
    status,
    caption,
    voiceStatus,
    content,
    offlineStatus,
  );
  app.replaceChildren(root);
  app.removeAttribute('aria-busy');
  apply();
  chrome();
  const unsubStatus = host.subscribeStatus((state) => {
    document.body.dataset.gamePaused = String(state.pauseReasons.length > 0);
    saveStatus.textContent = message(
      state.checkpoint === 'failed'
        ? 'storageFailure'
        : state.checkpoint === 'pending'
          ? 'storagePending'
          : state.pendingAction !== null
            ? 'pendingAction'
            : state.durableRevision === null
              ? 'storageIdle'
              : 'storageSaved',
    );
    if (state.pauseReasons.length) narration.pause();
  });
  const visibility = bindVisibilityPause(
    document,
    (reason) => host.pause(reason),
    (reason) => {
      void commands.resume(reason).catch(fail);
      if (!host.getStatus().pauseReasons.length) void narration.resume().catch(fail);
    },
  );
  void offline
    .inspect({ id: 'aegis-reference-labs', revision: packRevision })
    .then((pack) => {
      offlineStatus.textContent = message(pack ? 'offlineReady' : 'offlineMissing');
    })
    .catch(() => {
      offlineStatus.textContent = message('offlineFailed');
    });
  window.addEventListener(
    'pagehide',
    () => {
      visibility();
      unsubStatus();
      commands.dispose();
      void narration.dispose().catch(fail);
      void host.dispose().catch(fail);
    },
    { once: true },
  );
  return {
    content,
    root,
    status,
    caption,
    button,
    fail,
    message: (key: string, values?: Record<string, string>) => message(key, values),
    setRender(callback: () => void): void {
      render = callback;
      render();
    },
    preferences: () => preferences,
    captureDispatch: commands.capture,
    resume: commands.resume,
    setLine(id: string): void {
      if (lineId !== id) narration.clear();
      lineId = id;
      caption.textContent = message(id);
    },
    hidePrivate(): void {
      narration.clear();
      caption.textContent = '';
      status.textContent = '';
    },
    baseUrl,
    atmosphere(value: 'slow' | 'fast' | null): void {
      if (desiredAtmosphere === value) return;
      desiredAtmosphere = value;
      if (ambienceEnabled)
        void narration
          .setAtmosphere(
            value ? { packId: 'lab-atmosphere', asset: value, fadeSeconds: 0.25 } : null,
          )
          .catch(fail);
    },
  };
}
