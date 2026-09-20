import { defineComponent } from '@aegis/core';
import type { ComponentType } from '@aegis/core';
import { describeComponent } from '@aegis/content';

export interface HorrorPlayerData {
  flashlight: boolean;
  crouched: boolean;
  sprinting: boolean;
  stamina: number;
  exhausted: boolean;
  noise: number;
  distance: number;
  footstep: number;
}

export const HorrorPlayer = defineComponent<HorrorPlayerData>({
  id: 'HorrorPlayer',
  defaults: () => ({
    flashlight: true,
    crouched: false,
    sprinting: false,
    stamina: 6,
    exhausted: false,
    noise: 0,
    distance: 0,
    footstep: 0,
  }),
});

export const HorrorStatus = defineComponent({
  id: 'HorrorStatus',
  defaults: () => ({
    objective: 'Find an auxiliary fuse in MAINTENANCE.',
    prompt: '',
    subtitle: '',
    subtitleUntil: 0,
    threat: 'No movement on the suit scanner.',
    ended: false,
    musicPhase: 'explore',
  }),
});

export const HorrorMission = defineComponent({
  id: 'HorrorMission',
  defaults: () => ({
    arrived: false,
    fuse: false,
    service: false,
    busIsolated: false,
    power: false,
    visitorToken: false,
    recorder: false,
    coolant: false,
    uplink: false,
    escaped: false,
    dead: false,
    completedTick: -1,
    evidence: 0,
  }),
});

export interface HorrorInteractableData {
  kind: string;
  label: string;
  holdTicks: number;
  progress: number;
  used: boolean;
  selection: number;
  transcript: string;
}

export const HorrorInteractable = defineComponent<HorrorInteractableData>({
  id: 'HorrorInteractable',
  defaults: () => ({
    kind: 'arrival',
    label: '',
    holdTicks: 1,
    progress: 0,
    used: false,
    selection: 0,
    transcript: '',
  }),
});
describeComponent(HorrorInteractable, {
  enums: {
    kind: [
      'arrival',
      'fuse',
      'maintenance',
      'service',
      'isolate-bus',
      'power',
      'triage',
      'recorder',
      'coolant',
      'uplink',
      'escape',
    ],
  },
});

export type ThreatMode = 'dormant' | 'patrol' | 'search' | 'chase';
export interface HorrorThreatData {
  mode: ThreatMode;
  suspicion: number;
  lostTicks: number;
  searchTicks: number;
  attackTicks: number;
  warningCooldown: number;
  patrolIndex: number;
  targetX: number;
  targetZ: number;
  facingX: number;
  facingZ: number;
  repathTicks: number;
  path: { x: number; z: number }[];
  footDistance: number;
  footstep: number;
  hadChase: boolean;
}

export const HorrorThreat = defineComponent<HorrorThreatData>({
  id: 'HorrorThreat',
  defaults: () => ({
    mode: 'dormant',
    suspicion: 0,
    lostTicks: 0,
    searchTicks: 0,
    attackTicks: 0,
    warningCooldown: 0,
    patrolIndex: 0,
    targetX: 27,
    targetZ: 29,
    facingX: 0,
    facingZ: -1,
    repathTicks: 0,
    path: [],
    footDistance: 0,
    footstep: 0,
    hadChase: false,
  }),
});
describeComponent(HorrorThreat, { enums: { mode: ['dormant', 'patrol', 'search', 'chase'] } });

export const HORROR_COMPONENTS: readonly ComponentType<unknown>[] = [
  HorrorPlayer,
  HorrorStatus,
  HorrorMission,
  HorrorInteractable,
  HorrorThreat,
];
