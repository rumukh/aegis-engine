import { DEFAULT_SAVE_BYTES, exportSave, importSave } from '@aegis/browser/save';
import type { SaveHistory, SavePolicy, SaveStorage } from '@aegis/browser/save';
import { createActionButton, openDialog } from '@aegis/browser/ui';
import { element } from './shell.js';
import { russian } from './catalogs.js';

export class StartupRecoveryError extends Error {
  constructor(
    cause: unknown,
    readonly actions: {
      available: boolean;
      original?: string;
      previous?: string;
      replace(text: string): Promise<void>;
      reset(): Promise<void>;
    },
  ) {
    super('Saved progress requires explicit recovery.', { cause });
  }
}

export async function recoveryFor<State>(
  storage: SaveStorage,
  policy: SavePolicy<State, null>,
  cause: unknown,
  validate: (state: State) => Promise<void>,
): Promise<StartupRecoveryError> {
  let history: SaveHistory;
  try {
    history = await storage.read(policy);
  } catch (storageCause) {
    return new StartupRecoveryError(storageCause, {
      available: false,
      replace: () => Promise.reject(storageCause),
      reset: () => Promise.reject(storageCause),
    });
  }
  const revision = history.revision ?? history.current?.revision ?? 0;
  return new StartupRecoveryError(cause, {
    available: true,
    original: history.current?.payload,
    previous: history.previous?.payload,
    async replace(text) {
      const candidate = importSave(text, policy);
      await validate(candidate.state);
      const next = revision + 1;
      await storage.compareAndSwap(policy, revision, {
        revision: next,
        payload: exportSave({ ...candidate, revision: next }, policy),
      });
    },
    async reset() {
      await storage.reset(policy, revision, { gameId: policy.gameId, profileId: policy.profileId });
    },
  });
}

export function showRecovery(root: Element, recovery: StartupRecoveryError): void {
  const main = element('main');
  main.dataset.testid = 'startup-recovery';
  const notice = element('p', russian.recoveryNotice);
  notice.setAttribute('role', 'alert');
  const status = element('p');
  status.setAttribute('role', 'status');
  status.dataset.testid = 'recovery-status';
  const error = (): void => {
    status.textContent = russian.recoveryFailed;
  };
  const button = (key: keyof typeof russian, command: () => void | Promise<void>) => {
    const node = createActionButton({ document, label: russian[key], command, onError: error });
    node.dataset.testid = 'recovery-' + key;
    return node;
  };
  main.append(
    element('h1', russian.recoveryTitle),
    notice,
    status,
    button('retryOpen', () => location.reload()),
  );
  const original = recovery.actions.original;
  if (original !== undefined)
    main.append(
      button('export', () => {
        const url = URL.createObjectURL(new Blob([original], { type: 'application/json' }));
        const link = element('a');
        link.href = url;
        link.download = 'original-recovery.json';
        link.click();
        URL.revokeObjectURL(url);
      }),
    );
  if (recovery.actions.available) {
    const file = element('input');
    file.type = 'file';
    file.accept = 'application/json';
    file.dataset.testid = 'recovery-file';
    const label = element('label', russian.import);
    label.append(file);
    main.append(label);
    main.append(
      button('recoveryImport', async () => {
        const selected = file.files?.[0];
        if (!selected || selected.size > DEFAULT_SAVE_BYTES)
          throw new Error('Select a bounded local backup.');
        await recovery.actions.replace(await selected.text());
        location.reload();
      }),
    );
    const previous = recovery.actions.previous;
    if (previous !== undefined)
      main.append(
        button('recoveryPrevious', async () => {
          await recovery.actions.replace(previous);
          location.reload();
        }),
      );
    main.append(
      button('reset', () => {
        const dialog = element('dialog');
        dialog.setAttribute('aria-label', russian.confirmReset);
        dialog.append(
          element('p', russian.resetWarning),
          button('confirmReset', async () => {
            await recovery.actions.reset();
            location.reload();
          }),
          button('cancel', () => dialog.close()),
        );
        main.append(dialog);
        dialog.addEventListener('close', () => dialog.remove(), { once: true });
        openDialog(dialog);
      }),
    );
  }
  root.replaceChildren(main);
  root.removeAttribute('aria-busy');
}
