import { createSchedule } from '@aegis/core';
import type { ModePlugin } from '@aegis/harness';
import {
  FPS_COMPONENTS,
  FPS_EVENTS,
  FPS_INPUTS,
  FPS_RESOURCES,
  FPS_SYSTEMS,
  FpsViewProvider,
  initFloorplan,
} from '@aegis/mode-fps';
import { HORROR_COMPONENTS } from './components.js';
import { HORROR_SYSTEMS } from './systems.js';

// Every horror event carries the subject's name, world position and authoritative tick.
const subject = {
  entity: 'string',
  position: { fields: { x: 'number', y: 'number', z: 'number' } },
  tick: 'number',
} as const;
const fact = { fields: subject } as const;
const step = { ...subject, variant: 'number' } as const;

export const nullMeridianPlugin: ModePlugin = {
  mode: 'fps',
  components: () => [...FPS_COMPONENTS, ...HORROR_COMPONENTS],
  resources: () => FPS_RESOURCES,
  inputs: () => ({
    ...FPS_INPUTS,
    actions: [...FPS_INPUTS.actions, 'Crouch', 'Flashlight', 'Interact', 'Select', 'Sprint'],
  }),
  events: () => ({
    ...FPS_EVENTS,
    'horror.arrived': fact,
    'horror.arrival.read': fact,
    'horror.bus.isolated': fact,
    'horror.coolant.isolated': fact,
    'horror.flashlight.changed': { fields: { ...subject, enabled: 'boolean' } },
    'horror.fuse.taken': fact,
    'horror.interaction.denied': { fields: { ...subject, reason: 'string' } },
    'horror.maintenance.read': fact,
    'horror.player.step': { fields: { ...step, style: { enum: ['crouch', 'sprint', 'walk'] } } },
    'horror.power.restored': fact,
    'horror.recorder.recovered': fact,
    'horror.recording.replayed': { fields: { ...subject, kind: 'string' } },
    'horror.rescue.called': fact,
    'horror.service.opened': fact,
    'horror.threat.awakened': fact,
    'horror.threat.chase': fact,
    'horror.threat.evaded': fact,
    'horror.threat.search': fact,
    'horror.threat.step': { fields: step },
    'horror.threat.suspicious': fact,
    'horror.threat.warning': fact,
    'horror.triage.played': fact,
    'horror.uplink.transmitted': fact,
    'level.completed': fact,
    'player.died': { fields: { ...subject, cause: 'string', attacker: 'string' } },
  }),
  init: initFloorplan,
  systems: () => createSchedule().addAll(FPS_SYSTEMS).addAll(HORROR_SYSTEMS),
  view: () => new FpsViewProvider(),
};
