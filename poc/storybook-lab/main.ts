import { createHotspotList, hitHotspot, logicalPoint } from '@aegis/browser/ui';
import { createShell, element } from '../lab-shared/shell.js';
import { readContent, showStartupFailure, startLab } from '../lab-shared/session.js';
import { createStoryAdapter, loadStoryContent } from './model.js';

async function main(): Promise<void> {
  const content = loadStoryContent(await readContent('./content.json'));
  const { host, persistence } = await startLab(createStoryAdapter(content), content);
  const shell = createShell(host, 'storybook-lab', 'storyTitle', persistence);
  let panel: 'story' | 'family' = 'story';
  let activity = 'dialogue';
  let selectedAxis = 'shape';
  let privateConfirmed = false;
  let selectedOrderItem: string | undefined;
  const hotspots = [
    { id: 'note', labelKey: 'note', x: 180, y: 265, width: 80, height: 50 },
    { id: 'window', labelKey: 'window', x: 60, y: 50, width: 200, height: 180 },
    { id: 'drop', labelKey: 'drop', x: 640, y: 190, width: 80, height: 70 },
  ];
  const render = (): void => {
    const act = shell.captureDispatch();
    const focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.testid
        : undefined;
    const view = host.getView();
    const t = shell.message;
    const root = element('div');
    root.append(
      shell.button(
        panel === 'story' ? 'family' : 'back',
        () => {
          panel = panel === 'story' ? 'family' : 'story';
          if (panel === 'story') host.resume('handoff');
          else if (view.family.phase === 'handoff') host.pause('handoff');
          shell.hidePrivate();
          render();
        },
        'family-toggle',
      ),
    );
    if (panel === 'family') {
      shell.hidePrivate();
      const section = element('section');
      section.className = 'panel';
      if (
        view.family.phase === 'handoff' ||
        !privateConfirmed ||
        shell.preferences().hideSpoilers
      ) {
        section.append(element('h2', t('handoff')));
        if (!shell.preferences().hideSpoilers) {
          const recipient =
            view.family.phase === 'handoff' ? view.family.nextPlayer : view.family.player;
          section.append(
            element('p', t('player.' + recipient)),
            shell.button('confirmPlayer', async () => {
              host.resume('handoff');
              if (view.family.phase === 'handoff')
                await act({ type: 'confirm', player: recipient });
              privateConfirmed = true;
              render();
            }),
          );
        }
      } else {
        section.append(element('h2', t('player.' + view.family.player)));
        for (const card of view.family.cards) {
          if (typeof card.content !== 'string') throw new Error('Invalid private label');
          section.append(element('p', t(card.content)));
        }
        section.append(
          shell.button('nextPlayer', async () => {
            const next =
              view.family.phase === 'active' && view.family.player === 'first' ? 'second' : 'first';
            privateConfirmed = false;
            shell.hidePrivate();
            await act({ type: 'handoff', player: next });
            host.pause('handoff');
          }),
        );
      }
      root.append(section);
    } else {
      const scene = element('section');
      scene.className = 'scene';
      if (view.scene === 'map') {
        scene.append(
          element('p', t('mapText')),
          shell.button('roomLocation', () => act({ type: 'scene', value: 'room' })),
        );
      } else {
        const image = element('img');
        image.src = '../assets/room.svg';
        image.alt = t('roomImage');
        image.addEventListener('click', (event) => {
          const target = hitHotspot(
            logicalPoint({ x: event.clientX, y: event.clientY }, image.getBoundingClientRect(), {
              width: 800,
              height: 450,
            }),
            hotspots,
          );
          if (target && view.puzzles.find((item) => item.id === 'scene')?.status === 'active') {
            const original = view.puzzles.find((item) => item.id === 'scene');
            if (!original) throw new Error('Missing scene activity');
            void act({
              type: 'puzzle',
              id: 'scene',
              value: { target },
              revision: original.revision,
            }).catch(shell.fail);
          }
        });
        const avatar = element('div');
        avatar.className = 'avatar';
        avatar.setAttribute('aria-label', t('avatar'));
        for (const file of ['avatar.svg', ...(view.scarf ? ['scarf.svg'] : [])]) {
          const layer = element('img');
          layer.src = '../assets/' + file;
          layer.alt = '';
          avatar.append(layer);
        }
        scene.append(image, avatar);
      }
      const customization = element('div');
      customization.className = 'controls';
      const name = element('input');
      name.value = view.name;
      name.maxLength = 40;
      name.dataset.testid = 'display-name';
      const label = element('label', t('name'));
      label.append(name);
      customization.append(
        label,
        shell.button('setName', () => act({ type: 'name', value: name.value })),
        shell.button('scarf', () => act({ type: 'scarf', value: !view.scarf })),
        shell.button('map', () => act({ type: 'scene', value: 'map' })),
      );
      const dialogue = element('section');
      dialogue.className = 'panel';
      dialogue.append(element('p', t(view.story.text)));
      const choices = element('div');
      choices.className = 'choices';
      for (const choice of view.story.choices) {
        const button = shell.button(
          choice.text,
          () =>
            act({
              type: 'choice',
              choice: choice.id,
              node: view.story.node,
              revision: view.story.revision,
            }),
          'choice-' + choice.id,
        );
        button.disabled = !choice.enabled;
        choices.append(button);
      }
      dialogue.append(choices);
      const activities = element('nav');
      for (const key of ['dialogue', 'scene', 'matching', 'ordering', 'notebook', 'extras']) {
        activities.append(
          shell.button(
            key,
            () => {
              activity = key;
              selectedOrderItem = undefined;
              render();
            },
            'activity-' + key,
          ),
        );
      }
      root.append(scene, customization, activities);
      if (activity === 'dialogue') root.append(dialogue);
      for (const puzzle of view.puzzles.filter((item) => item.id === activity)) {
        const section = element('section');
        section.className = 'panel';
        section.dataset.testid = 'puzzle-' + puzzle.id;
        section.append(element('h2', t(puzzle.id)));
        if (puzzle.status === 'completed') section.append(element('p', t('completed')));
        else if (puzzle.id === 'scene') {
          section.append(
            createHotspotList({
              document,
              onError: shell.fail,
              label: t('scene'),
              message: t,
              hotspots,
              activate: async (target) => {
                await act({
                  type: 'puzzle',
                  id: 'scene',
                  value: { target },
                  revision: puzzle.revision,
                });
                if (target === 'drop') shell.status.textContent = t('drop.explanation');
              },
            }),
          );
        } else if (puzzle.id === 'matching') {
          const cards = element('div');
          cards.className = 'choices';
          for (const card of ['round', 'sun'])
            cards.append(
              shell.button(
                card,
                () =>
                  act({
                    type: 'puzzle',
                    id: 'matching',
                    value: { type: 'select', card },
                    revision: puzzle.revision,
                  }),
                'match-' + card,
              ),
            );
          section.append(cards);
        } else {
          const choices = element('div');
          choices.className = 'choices';
          for (const item of ['morning', 'day', 'evening'])
            choices.append(
              shell.button(
                item,
                () => {
                  selectedOrderItem = item;
                  shell.status.textContent = t('selected', { item: t(item) });
                  render();
                },
                'order-' + item,
              ),
            );
          const destinations = element('div');
          destinations.className = 'choices';
          const order =
            typeof puzzle.progress === 'object' &&
            puzzle.progress !== null &&
            !Array.isArray(puzzle.progress) &&
            Array.isArray(puzzle.progress.order)
              ? puzzle.progress.order
              : [];
          for (let index = 0; index < 3; index++) {
            const orderedItem = order[index];
            const label = typeof orderedItem === 'string' ? t(orderedItem) : '';
            const destination = shell.button(
              'place',
              async () => {
                if (!selectedOrderItem) {
                  shell.status.textContent = t('aegis.browser.select-item');
                  return;
                }
                await act({
                  type: 'puzzle',
                  revision: puzzle.revision,
                  id: 'ordering',
                  value: { type: 'place', item: selectedOrderItem, index },
                });
                selectedOrderItem = undefined;
                render();
              },
              'order-position-' + index,
            );
            destination.textContent = `${index + 1}: ${label}`;
            destinations.append(destination);
          }
          section.append(
            selectedOrderItem ? destinations : choices,
            shell.button(
              'submit',
              () =>
                act({
                  type: 'puzzle',
                  id: 'ordering',
                  value: { type: 'submit' },
                  revision: puzzle.revision,
                }),
              'order-submit',
            ),
          );
        }
        root.append(section);
      }
      const notebook = element('section');
      notebook.className = 'panel';
      notebook.append(
        element('h2', t('notebook')),
        element('p', t('candidates', { count: String(view.candidates) })),
      );
      for (const clue of view.clues) notebook.append(element('p', t('clue.' + clue)));
      notebook.append(shell.button('hint', () => act({ type: 'hint' })));
      if (view.hints) notebook.append(element('p', t('hint.explained')));
      const axisLabel = element('label', t('axis'));
      const axisSelect = element('select');
      for (const axis of content.data.deduction.axes) {
        const option = element('option', t(axis.id));
        option.value = axis.id;
        option.selected = axis.id === selectedAxis;
        axisSelect.append(option);
      }
      axisSelect.addEventListener('change', () => {
        selectedAxis = axisSelect.value;
        render();
      });
      axisLabel.append(axisSelect);
      notebook.append(axisLabel);
      for (const axis of content.data.deduction.axes.filter((item) => item.id === selectedAxis)) {
        const group = element('div');
        group.className = 'choices';
        for (const value of axis.values)
          group.append(
            shell.button(
              value,
              () => act({ type: 'mark', axis: axis.id, value }),
              'mark-' + axis.id + '-' + value,
            ),
          );
        notebook.append(group);
      }
      for (const mark of view.marks)
        notebook.append(element('p', `${t(mark.value)}: ${t(mark.mark)}`));
      if (activity === 'notebook') root.append(notebook);
      const extras = element('section');
      extras.className = 'panel';
      extras.append(shell.button('generated', () => act({ type: 'generate' })));
      if (view.generated) extras.append(element('p', t(view.generated)));
      extras.append(element('p', t('printScope')));
      for (const paper of ['a4', 'letter']) {
        const link = element('a', t('print') + ' (' + paper.toUpperCase() + ')');
        link.href = new URL(`print-${paper}.html`, shell.baseUrl).href;
        extras.append(link);
      }
      if (activity === 'extras') root.append(extras);
      shell.setLine(view.reward ? 'lab.complete' : view.clues.length ? 'lab.clue' : 'lab.welcome');
    }
    shell.content.replaceChildren(root);
    if (focus)
      shell.root.querySelector<HTMLElement>(`[data-testid="${CSS.escape(focus)}"]`)?.focus();
  };
  host.subscribe((_view, reason) => {
    if (reason === 'restore') {
      privateConfirmed = false;
      selectedOrderItem = undefined;
      shell.hidePrivate();
    }
    render();
  });
  shell.setRender(render);
}
void main().catch(showStartupFailure);
