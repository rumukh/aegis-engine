import { createSaveCheckpoint } from '@aegis/browser/checkpoint';
import { IndexedDbSaveStorage } from '@aegis/browser/indexeddb';
import { createInstallationRequest } from '@aegis/browser/offline';
import { exportSave, importSave, SaveService } from '@aegis/browser/save';
import type { SaveDraft, SavePolicy } from '@aegis/browser/save';
import { isPresentationPreferences } from '@aegis/browser/ui';
import type { PresentationPreferences } from '@aegis/browser/ui';
import { createRuntimeHost, isRuntimeSnapshot, requireValue } from '@aegis/runtime';
import type { ContentPack, RuntimeAdapter, RuntimeSnapshot } from '@aegis/runtime';
import { defaultPreferences, element } from './shell.js';
import type { ShellPersistence } from './shell.js';
import { russian } from './catalogs.js';
import { recoveryFor, showRecovery, StartupRecoveryError } from './recovery.js';

export async function startLab<S, A, V, C>(
  adapter: RuntimeAdapter<S, A, V, C>,
  content: ContentPack<C>,
) {
  const storage = new IndexedDbSaveStorage('aegis-reference-labs');
  const acceptedContent = new Set([content.revision]);
  const policy: SavePolicy<RuntimeSnapshot, null> = {
    gameId: adapter.id,
    profileId: 'default',
    schemaVersion: 1,
    engineId: 'aegis-runtime',
    engineSnapshotVersion: 1,
    acceptsContent: (revision) => acceptedContent.has(revision),
    validateState: (value) => isRuntimeSnapshot(value),
    isCurrentState: isRuntimeSnapshot,
    validateResume: (value): value is null => value === null,
  };
  const saves = new SaveService(storage, policy);
  const preferencesPolicy: SavePolicy<PresentationPreferences, null> = {
    gameId: adapter.id + '-preferences',
    profileId: 'default',
    schemaVersion: 1,
    engineId: 'presentation',
    engineSnapshotVersion: 1,
    acceptsContent: (revision) => revision === 'lab-1',
    validateState: isPresentationPreferences,
    isCurrentState: isPresentationPreferences,
    validateResume: (value): value is null => value === null,
  };
  const preferenceSaves = new SaveService(storage, preferencesPolicy);
  const validateSnapshot = async (snapshot: RuntimeSnapshot): Promise<void> => {
    const probe = createRuntimeHost({ adapter, content, seed: adapter.id });
    try {
      requireValue(await probe.restore(snapshot));
    } finally {
      await probe.dispose();
    }
  };
  let saved;
  try {
    saved = await saves.load();
    if (saved) await validateSnapshot(saved.state);
  } catch (cause) {
    throw await recoveryFor(storage, policy, cause, validateSnapshot);
  }
  let savedPreferences;
  try {
    savedPreferences = await preferenceSaves.load();
  } catch (cause) {
    throw await recoveryFor(storage, preferencesPolicy, cause, async () => {});
  }
  let preferences = savedPreferences?.state ?? structuredClone(defaultPreferences);
  const metadata = (
    snapshot: RuntimeSnapshot,
  ): Omit<SaveDraft<RuntimeSnapshot, null>, 'state'> => ({
    format: 'aegis.save',
    formatVersion: 1,
    gameId: adapter.id,
    profileId: 'default',
    schemaVersion: 1,
    engine: { id: 'aegis-runtime', snapshotVersion: 1, revision: 'runtime-1' },
    contentRevision: snapshot.content.revision,
    resume: null,
  });
  const checkpoint = createSaveCheckpoint(saves, ({ snapshot }) => {
    acceptedContent.add(snapshot.content.revision);
    return metadata(snapshot);
  });
  const host = createRuntimeHost({ adapter, content, seed: adapter.id, checkpoint });
  if (saved)
    requireValue(await host.restore(saved.state, { durableRevision: saved.state.revision }));
  const persistence: ShellPersistence = {
    preferences,
    async savePreferences(value) {
      await preferenceSaves.save({
        format: 'aegis.save',
        formatVersion: 1,
        gameId: preferencesPolicy.gameId,
        profileId: 'default',
        contentRevision: 'lab-1',
        schemaVersion: 1,
        engine: { id: 'presentation', snapshotVersion: 1, revision: 'lab-1' },
        state: value,
        resume: null,
      });
      preferences = structuredClone(value);
    },
    async exportBackup() {
      requireValue(await host.flush());
      const record = await storage.read(policy);
      if (!record.current) throw new Error('No acknowledged save to export');
      return exportSave(importSave(record.current.payload, policy), policy);
    },
    async importBackup(text) {
      const candidate = importSave(text, policy);
      requireValue(await host.restore(candidate.state));
    },
    async reset() {
      await saves.reset({ gameId: adapter.id, profileId: 'default' });
    },
    async load() {
      const candidate = await saves.load();
      if (!candidate) throw new Error('No saved progress');
      requireValue(
        await host.restore(candidate.state, { durableRevision: candidate.state.revision }),
      );
    },
  };
  return { host, persistence };
}

export async function readContent(path: string, update = false): Promise<string> {
  const request = update ? createInstallationRequest(path, new URL('.', location.href).href) : path;
  const response = await fetch(request);
  if (!response.ok) throw new Error(`Content unavailable (${response.status})`);
  return response.text();
}

export function showStartupFailure(cause: unknown): void {
  const root = document.querySelector('#app');
  if (!root) return;
  if (cause instanceof StartupRecoveryError) {
    showRecovery(root, cause);
    return;
  }
  const message = element('p', russian.startupFailure);
  message.setAttribute('role', 'alert');
  const retry = element('button', russian.retryOpen);
  retry.type = 'button';
  retry.addEventListener('click', () => location.reload());
  root.replaceChildren(message, retry);
  root.removeAttribute('aria-busy');
}
