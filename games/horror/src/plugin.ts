import { createSchedule } from '@aegis/core';
import type { ModePlugin } from '@aegis/harness';
import {
  FPS_COMPONENTS,
  FPS_RESOURCES,
  FPS_SYSTEMS,
  FpsViewProvider,
  initFloorplan,
} from '@aegis/mode-fps';
import { HORROR_COMPONENTS } from './components.js';
import { HORROR_SYSTEMS } from './systems.js';

export const nullMeridianPlugin: ModePlugin = {
  mode: 'fps',
  components: () => [...FPS_COMPONENTS, ...HORROR_COMPONENTS],
  resources: () => FPS_RESOURCES,
  init: initFloorplan,
  systems: () => createSchedule().addAll(FPS_SYSTEMS).addAll(HORROR_SYSTEMS),
  view: () => new FpsViewProvider(),
};
