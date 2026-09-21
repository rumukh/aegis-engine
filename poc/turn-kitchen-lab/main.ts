import { bindPlacementItem, bindPlacementSlot, createPlacement } from '@aegis/browser/ui';
import { requireValue } from '@aegis/runtime';
import { createShell, element } from '../lab-shared/shell.js';
import { readContent, showStartupFailure, startLab } from '../lab-shared/session.js';
import { kitchenAdapter, loadKitchenContent } from './model.js';

async function main(): Promise<void> {
  const content = loadKitchenContent(await readContent('./balance.json'));
  const { host, persistence } = await startLab(kitchenAdapter, content);
  const shell = createShell(host, 'turn-kitchen-lab', 'kitchenTitle', persistence);
  let placementDispatch = shell.captureDispatch();
  let cleanups: (() => void)[] = [];
  const placement = createPlacement({
    validate: (item, destination) => {
      const slots = host.getView().state.slots;
      return slots[Number(item)]?.item &&
        slots[Number(destination)] &&
        !slots[Number(destination)]?.item
        ? { ok: true }
        : { ok: false, messageKey: 'occupied' };
    },
    commit: (from, to) => placementDispatch({ type: 'move', from: Number(from), to: Number(to) }),
    onError: shell.fail,
    onChange: (state) => {
      if (state.selected && !state.busy) placementDispatch = shell.captureDispatch();
      if (state.messageKey) shell.status.textContent = shell.message(state.messageKey);
      else if (state.selected) {
        const item = host.getView().state.slots[Number(state.selected)]?.item;
        shell.status.textContent = shell.message('selected', {
          item: item ? shell.message(item) : '',
        });
      }
    },
  });
  const render = (): void => {
    const act = shell.captureDispatch();
    const focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.testid
        : undefined;
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    const { state, turn, remaining } = host.getView();
    const t = shell.message;
    const root = element('div');
    const ambient = element('span', '●');
    ambient.className = 'ambient-mark';
    ambient.setAttribute('aria-hidden', 'true');
    root.append(ambient);
    shell.atmosphere(
      state.terminal || state.screen === 'setup'
        ? null
        : state.screen === 'rest' || (remaining ?? 0) > 2
          ? 'slow'
          : 'fast',
    );
    root.append(
      element('h2', t('phase', { phase: t(state.screen) })),
      element('p', t('turns', { turn: String(turn), remaining: String(remaining ?? 0) })),
      element('p', t('produced', { count: String(state.produced) })),
      element('p', t('credit', { count: String(state.credit) })),
    );
    const controls = element('div');
    controls.className = 'controls';
    if (state.screen === 'setup')
      controls.append(shell.button('begin', () => act({ type: 'begin' })));
    else if (!state.terminal) {
      if (state.screen === 'workshop') {
        controls.append(
          shell.button('startA', () => act({ type: 'start', recipe: 'batch-a' })),
          shell.button('startB', () => act({ type: 'start', recipe: 'batch-b' })),
          shell.button('wait', () => act({ type: 'wait' })),
          shell.button('listen', () => act({ type: 'listen', actor: 'maker' })),
          shell.button('nextPhase', () => act({ type: 'next' })),
        );
      } else {
        controls.append(
          shell.button('finishShare', () => act({ type: 'finish', share: true })),
          shell.button('finishKeep', () => act({ type: 'finish', share: false })),
        );
      }
      controls.append(
        shell.button('hint', () => act({ type: 'hint' })),
        shell.button('purchase', () => act({ type: 'purchase' })),
        shell.button('budget', () =>
          act({ type: 'budget', allowance: (host.inspect().phase?.allowance ?? 0) + 1 }),
        ),
      );
    } else root.append(element('h2', t(state.terminal)));
    root.append(controls);
    const shelf = element('section');
    shelf.className = 'panel';
    shelf.append(element('h2', t('slots')));
    const slots = element('div');
    slots.className = 'slots';
    for (const [index, item] of state.slots.entries()) {
      const node = element(
        'button',
        t('slot', {
          number: String(index + 1),
          item: item.item ? t(item.item) : t('empty'),
          age: String(item.age),
        }),
      );
      node.type = 'button';
      node.dataset.slot = String(index);
      node.dataset.testid = 'slot-' + index;
      if (item.item) {
        cleanups.push(
          bindPlacementItem(node, String(index), placement, {
            onError: shell.fail,
            slotAt: (x, y) =>
              document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-slot]')?.dataset.slot,
          }),
        );
      } else cleanups.push(bindPlacementSlot(node, String(index), placement, shell.fail));
      slots.append(node);
    }
    shelf.append(
      slots,
      shell.button('cancelSelection', () => placement.cancel()),
    );
    root.append(shelf);
    const status = element('section');
    status.className = 'panel';
    for (const [id, value] of Object.entries(state.actors))
      status.append(element('p', `${t(id)}: ${t(value)}`));
    for (const [id, value] of Object.entries(state.batches))
      status.append(element('p', `${t(id)}: ${t(value)}`));
    status.append(element('p', t('ruleOrder')));
    root.append(status);
    const reload = shell.button('reloadConfig', async () => {
      host.pause('content-reload');
      try {
        const candidate = requireValue(
          host.stageContent(JSON.parse(await readContent('./balance.json', true))),
        );
        requireValue(await host.activateContent(candidate, 'restart'));
      } finally {
        await shell.resume('content-reload');
      }
      shell.status.textContent = t('balanceReady');
    });
    root.append(element('p', t('reloadWarning')), reload);
    shell.content.replaceChildren(root);
    if (focus)
      shell.root.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focus)}"]`)?.focus();
  };
  host.subscribe(() => {
    placement.cancel();
    render();
  });
  shell.setRender(render);
}
void main().catch(showStartupFailure);
