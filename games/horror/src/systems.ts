import { Name, Transform } from '@aegis/core';
import type { EntityView, System, World } from '@aegis/core';
import {
  atan2,
  clamp,
  dot3,
  length3,
  max,
  min,
  normalize3,
  quatFromEuler,
  sub3,
} from '@aegis/core/math';
import { Dead, Health } from '@aegis/content';
import {
  CapsuleBody,
  FpsCamera,
  FpsController,
  FPS_COLLISION,
  forwardFromLook,
  LookState,
  circleHitsSolid,
} from '@aegis/mode-fps';
import type { CollisionGrid } from '@aegis/mode-fps';
import {
  HorrorInteractable,
  HorrorMission,
  HorrorPlayer,
  HorrorStatus,
  HorrorThreat,
} from './components.js';
import type { HorrorThreatData, ThreatMode } from './components.js';
import { clearSight, stationPath } from './navigation.js';

export const WALK_SPEED = 2;
export const CROUCH_SPEED = 1.1;
export const SPRINT_SPEED = 3.8;
export const INTERACTION_RANGE = 1.8;

const PATROL = [
  { x: 27, z: 22 },
  { x: 21, z: 22 },
  { x: 15, z: 22 },
  { x: 15, z: 12 },
  { x: 24, z: 12 },
  { x: 24, z: 18 },
  { x: 27, z: 22 },
  { x: 27, z: 29 },
  { x: 21, z: 29 },
] as const;

function gridFor(world: World): CollisionGrid {
  const grid = world.getResource(FPS_COLLISION);
  if (grid === undefined) throw new Error('NULL MERIDIAN requires the initialized FPS floorplan');
  return grid;
}

function emit(
  world: World,
  event: string,
  subject: EntityView,
  data: Record<string, unknown> = {},
): void {
  world.events.emit(event, {
    entity: subject.get(Name).value,
    position: { ...subject.get(Transform).position },
    tick: world.tick,
    ...data,
  });
}

function say(player: EntityView, text: string, tick: number, seconds = 9): void {
  const status = player.get(HorrorStatus);
  status.subtitle = text;
  status.subtitleUntil = tick + seconds * 60;
}

function openDoors(grid: CollisionGrid, keys: string): void {
  for (const cell of grid.cells) if (cell.door && keys.includes(cell.key)) cell.solid = false;
}

export const locomotionSystem: System = {
  name: 'horror.locomotion',
  phase: 'input',
  before: ['fps.intake'],
  run({ world, input, dt }) {
    const player = world
      .query({ has: [HorrorPlayer, FpsController, FpsCamera, CapsuleBody] })
      .one();
    const state = player.get(HorrorPlayer);
    const mission = world
      .query({ has: [HorrorMission] })
      .one()
      .get(HorrorMission);
    if (mission.dead || mission.escaped) {
      player.get(FpsController).moveSpeed = 0;
      state.sprinting = false;
      state.noise = 0;
      return;
    }
    const moving = (input.axes['Forward'] ?? 0) !== 0 || (input.axes['Strafe'] ?? 0) !== 0;
    state.crouched = input.actions['Crouch'] === true;
    if (state.stamina >= 1.5) state.exhausted = false;
    if (state.stamina <= 0.1) state.exhausted = true;
    state.sprinting =
      !state.crouched && moving && input.actions['Sprint'] === true && !state.exhausted;
    state.stamina = clamp(state.stamina + (state.sprinting ? -dt : dt * 0.65), 0, 6);
    const speed = state.crouched ? CROUCH_SPEED : state.sprinting ? SPRINT_SPEED : WALK_SPEED;
    player.get(FpsController).moveSpeed = speed;
    player.get(FpsCamera).eyeHeight = state.crouched ? 1.05 : 1.62;
    player.get(CapsuleBody).height = state.crouched ? 1.2 : 1.75;
    if (input.pressed.includes('Flashlight')) {
      state.flashlight = !state.flashlight;
      emit(world, 'horror.flashlight.changed', player, { enabled: state.flashlight });
    }
  },
};

// The stock FPS intake permits diagonal axes > unit length. Clamp game movement without
// changing any of the existing FPS game's semantics or the shared input contract.
export const normalizeMovementSystem: System = {
  name: 'horror.normalize-movement',
  phase: 'input',
  after: ['fps.intake'],
  run({ world }) {
    const player = world.query({ has: [HorrorPlayer, FpsController, CapsuleBody] }).one();
    const velocity = player.get(CapsuleBody).velocity;
    const speed = length3({ x: velocity.x, y: 0, z: velocity.z });
    const limit = player.get(FpsController).moveSpeed;
    if (speed > limit && speed > 0) {
      velocity.x *= limit / speed;
      velocity.z *= limit / speed;
    }
  },
};

export const footstepSystem: System = {
  name: 'horror.footsteps',
  phase: 'postUpdate',
  run({ world, dt }) {
    const player = world.query({ has: [HorrorPlayer, CapsuleBody, Transform] }).one();
    const state = player.get(HorrorPlayer);
    const velocity = player.get(CapsuleBody).velocity;
    const distance = length3({ x: velocity.x, y: 0, z: velocity.z }) * dt;
    state.noise = distance > 0 ? (state.sprinting ? 12 : state.crouched ? 1.2 : 4) : 0;
    state.distance += distance;
    if (state.distance < (state.crouched ? 1.1 : 0.9)) return;
    state.distance = 0;
    emit(world, 'horror.player.step', player, {
      style: state.crouched ? 'crouch' : state.sprinting ? 'sprint' : 'walk',
      variant: state.footstep % 4,
    });
    state.footstep++;
  },
};

const SELECTIONS: Readonly<Record<string, readonly string[]>> = {
  power: ['RESCUE BUS', 'HABITAT HEAT', 'MEDICAL / ARCHIVE'],
  coolant: ['PRESSURE SUPPLY', 'COOLANT RETURN', 'EMERGENCY BYPASS'],
  uplink: ['RESCUE NETWORK', 'INDEPENDENT CAPSULE'],
};

function denial(
  kind: string,
  mission: ReturnType<typeof HorrorMission.create>,
  selection: number,
): string | undefined {
  if (kind === 'power' && !mission.fuse)
    return 'The auxiliary socket is empty. Find a fuse in MAINTENANCE.';
  if (kind === 'power' && !mission.busIsolated)
    return 'Unsafe backfeed. Isolate the failed rescue bus at the physical disconnect across this gallery.';
  if (kind === 'power' && selection !== 2)
    return 'Load rejected. The maintenance slate identifies the only intact feeder. Q / X changes the selected circuit.';
  if (kind === 'recorder' && !mission.power) return 'Archive storage has no power.';
  if (kind === 'recorder' && !mission.visitorToken)
    return 'Private medical record. Recover the last visitor authorization from the INFIRMARY recorder.';
  if (kind === 'coolant' && !mission.recorder)
    return 'Valve interlock active. Recover the archive recorder to obtain the isolation procedure.';
  if (kind === 'coolant' && selection !== 1)
    return 'Unsafe isolation. The black box identifies the contaminated line. Do not cut capsule pressure.';
  if (kind === 'uplink' && !mission.coolant)
    return 'Observation is under thermal quarantine. Isolate the coolant return in MAINTENANCE.';
  if (kind === 'uplink' && selection !== 1)
    return 'Rescue network answered: patient retrieval dispatched. Choose the independent capsule authority, not the compromised responder.';
  if (kind === 'escape' && !mission.uplink)
    return 'Evacuation authorization missing. Transmit the recorder from OBSERVATION.';
  return undefined;
}

function useInteraction(world: World, player: EntityView, target: EntityView, tick: number): void {
  const interaction = target.get(HorrorInteractable);
  const mission = world
    .query({ has: [HorrorMission] })
    .one()
    .get(HorrorMission);
  const status = player.get(HorrorStatus);
  const grid = gridFor(world);
  if (interaction.used) {
    say(player, interaction.transcript, tick, 15);
    emit(world, 'horror.recording.replayed', target, { kind: interaction.kind });
    return;
  }
  const refused = denial(interaction.kind, mission, interaction.selection);
  if (refused !== undefined) {
    say(player, refused, tick, 6);
    emit(world, 'horror.interaction.denied', target, { reason: refused });
    if (interaction.kind === 'uplink' && mission.coolant) {
      const responder = world.query({ has: [HorrorThreat, Transform] }).one();
      const ai = responder.get(HorrorThreat);
      changeThreat(world, responder, 'search', 'horror.threat.search');
      ai.targetX = target.get(Transform).position.x;
      ai.targetZ = target.get(Transform).position.z;
      ai.searchTicks = 1200;
      emit(world, 'horror.rescue.called', target);
    }
    return;
  }
  interaction.used = true;
  const fire = (event: string, text: string): void => {
    interaction.transcript = text;
    emit(world, event, target);
    say(player, text, tick);
  };
  switch (interaction.kind) {
    case 'arrival':
      mission.evidence++;
      fire(
        'horror.arrival.read',
        'Dock report: no crew response. Auxiliary fuse stored in west maintenance. Do not reactivate the rescue network.',
      );
      break;
    case 'fuse':
      mission.fuse = true;
      status.objective = 'Diagnose the feeder from the maintenance slate. Restore POWER.';
      fire(
        'horror.fuse.taken',
        'Auxiliary fuse secured. The power gallery is north of maintenance. Its service bulkhead has a manual release.',
      );
      break;
    case 'maintenance':
      mission.evidence++;
      fire(
        'horror.maintenance.read',
        'Maintenance slate: rescue bus shorted; habitat heater ruptured. Open the rescue disconnect before backfeeding MEDICAL / ARCHIVE. The responder follows light and boot noise. Break sight behind solid machinery.',
      );
      break;
    case 'service':
      mission.service = true;
      openDoors(grid, 'D');
      fire('horror.service.opened', 'Manual latch released. Power gallery accessible.');
      break;
    case 'isolate-bus':
      mission.busIsolated = true;
      fire(
        'horror.bus.isolated',
        'Rescue bus physically isolated. The auxiliary fuse can now feed one intact circuit. Check the maintenance slate before energizing.',
      );
      break;
    case 'power':
      mission.power = true;
      openDoors(grid, 'PA');
      status.objective = 'Investigate INFIRMARY for archive access. Avoid the responder.';
      fire(
        'horror.power.restored',
        'Auxiliary power restored. Archive unlocked. Rescue unit responding... no living crew signature detected.',
      );
      break;
    case 'triage':
      mission.visitorToken = true;
      mission.evidence++;
      status.objective = 'Use the visitor authorization at the ARCHIVE recorder.';
      fire(
        'horror.triage.played',
        'Visitor authorization copied. Infirmary recording: it kept bringing us back. We were not injured. We were trying to leave. Turn off your light; do not call its rescue network.',
      );
      break;
    case 'recorder':
      mission.recorder = true;
      status.objective = 'Isolate the coolant return in west MAINTENANCE.';
      fire(
        'horror.recorder.recovered',
        'Black box: isolate COOLANT RETURN, never the pressure supply. Transmit to the INDEPENDENT CAPSULE from observation. Rescue-network authority is compromised. Your departure is not a medical emergency.',
      );
      break;
    case 'coolant':
      mission.coolant = true;
      openDoors(grid, 'O');
      status.objective = 'Reach OBSERVATION. Transmit the black-box evidence.';
      fire(
        'horror.coolant.isolated',
        'Coolant return isolated. Observation quarantine released. The evacuation uplink is available.',
      );
      break;
    case 'uplink':
      mission.uplink = true;
      openDoors(grid, 'E');
      status.objective = 'Board the east EVAC capsule and seal the hatch.';
      fire(
        'horror.uplink.transmitted',
        'Evidence transmitted. One evacuation berth authorized. East capsule unlocked. Leave the rescue network behind.',
      );
      break;
    case 'escape':
      mission.escaped = true;
      mission.completedTick = tick;
      status.ended = true;
      status.musicPhase = 'off';
      status.objective = 'CLEAR OF NULL MERIDIAN';
      status.threat = 'Capsule separated. No pursuit.';
      fire(
        'level.completed',
        'Capsule away. The station falls silent behind you. Your evidence is the only crew that came home.',
      );
      break;
    default:
      throw new Error(`NULL MERIDIAN: unknown interaction kind "${interaction.kind}"`);
  }
}

export const interactionSystem: System = {
  name: 'horror.interaction',
  phase: 'postUpdate',
  after: ['fps.camera'],
  run({ world, input, tick }) {
    const player = world
      .query({ has: [HorrorPlayer, HorrorStatus, Transform, LookState, FpsCamera] })
      .one();
    const status = player.get(HorrorStatus);
    const mission = world
      .query({ has: [HorrorMission] })
      .one()
      .get(HorrorMission);
    if (!mission.arrived) {
      mission.arrived = true;
      emit(world, 'horror.arrived', player);
      say(
        player,
        'NULL MERIDIAN / Docking complete. No response from station control. Find auxiliary power. E / A interacts; C / B moves quietly; F / Y toggles your light.',
        tick,
        14,
      );
    }
    if (tick >= status.subtitleUntil) status.subtitle = '';
    status.prompt = '';
    if (mission.dead || mission.escaped) return;
    const feet = player.get(Transform).position;
    const eye = { ...feet, y: feet.y + player.get(FpsCamera).eyeHeight };
    const look = player.get(LookState);
    const forward = forwardFromLook(look.yawDeg, look.pitchDeg);
    const grid = gridFor(world);
    let selected: EntityView | undefined;
    let nearest = INTERACTION_RANGE;
    const targets = world.query({ has: [HorrorInteractable, Transform] }).views();
    for (const target of targets) {
      const data = target.get(HorrorInteractable);
      if (data.used && !['arrival', 'maintenance', 'triage', 'recorder'].includes(data.kind))
        continue;
      const position = target.get(Transform).position;
      const point = { ...position, y: position.y + 1.2 };
      const difference = sub3(point, eye);
      const distance = length3(difference);
      if (
        distance >= nearest ||
        dot3(normalize3(difference), forward) < 0.6 ||
        !clearSight(grid, eye, point)
      )
        continue;
      nearest = distance;
      selected = target;
    }
    for (const target of targets) {
      if (target.entity !== selected?.entity || !input.actions['Interact']) {
        target.get(HorrorInteractable).progress = 0;
      }
    }
    if (selected === undefined) return;
    const data = selected.get(HorrorInteractable);
    if (data.used) {
      status.prompt = `[E / A] Review: ${data.label}`;
      if (input.pressed.includes('Interact')) useInteraction(world, player, selected, tick);
      return;
    }
    const selections = SELECTIONS[data.kind];
    if (selections !== undefined && input.pressed.includes('Select')) {
      data.selection = (data.selection + 1) % selections.length;
      data.progress = 0;
    }
    status.prompt = `[E / A] ${data.label}`;
    if (selections !== undefined) status.prompt += ` | [Q / X] ${selections[data.selection]}`;
    if (!input.actions['Interact']) return;
    const refused = denial(data.kind, mission, data.selection);
    if (refused !== undefined) {
      if (input.pressed.includes('Interact')) useInteraction(world, player, selected, tick);
      return;
    }
    data.progress++;
    if (data.holdTicks > 1)
      status.prompt += ` (${Math.floor((100 * data.progress) / data.holdTicks)}%)`;
    if (data.progress >= data.holdTicks) useInteraction(world, player, selected, tick);
  },
};

function changeThreat(world: World, responder: EntityView, mode: ThreatMode, event: string): void {
  const ai = responder.get(HorrorThreat);
  if (ai.mode === mode) return;
  ai.mode = mode;
  ai.path = [];
  ai.repathTicks = 0;
  emit(world, event, responder);
}

function moveThreat(
  world: World,
  responder: EntityView,
  ai: HorrorThreatData,
  grid: CollisionGrid,
  dt: number,
): void {
  const pos = responder.get(Transform).position;
  if (ai.repathTicks <= 0) {
    ai.path = stationPath(grid, pos, { x: ai.targetX, z: ai.targetZ }) ?? [];
    ai.repathTicks = 20;
  }
  ai.repathTicks--;
  let destination = ai.path[0];
  if (destination === undefined) {
    const target = { x: ai.targetX, y: 1, z: ai.targetZ };
    if (!clearSight(grid, { ...pos, y: 1 }, target)) return;
    destination = target;
  }
  const diff = { x: destination.x - pos.x, y: 0, z: destination.z - pos.z };
  const distance = length3(diff);
  if (distance < 0.02) {
    ai.path.shift();
    return;
  }
  const travel = min(
    distance,
    (ai.mode === 'chase' ? 2.65 : ai.mode === 'search' ? 1.5 : 1.15) * dt,
  );
  const dir = normalize3(diff);
  const x = pos.x + dir.x * travel;
  const z = pos.z + dir.z * travel;
  if (circleHitsSolid(grid, x, z, 0.28)) {
    ai.repathTicks = 0;
    return;
  }
  pos.x = x;
  pos.z = z;
  ai.facingX = dir.x;
  ai.facingZ = dir.z;
  responder.get(Transform).rotation = quatFromEuler(atan2(dir.x, dir.z), 0, 0);
  ai.footDistance += travel;
  if (ai.footDistance >= 0.8) {
    ai.footDistance = 0;
    emit(world, 'horror.threat.step', responder, { variant: ai.footstep % 3 });
    ai.footstep++;
  }
}

export const threatSystem: System = {
  name: 'horror.threat',
  phase: 'postUpdate',
  after: ['horror.footsteps', 'horror.interaction'],
  run({ world, tick, dt }) {
    const mission = world
      .query({ has: [HorrorMission] })
      .one()
      .get(HorrorMission);
    if (!mission.power || mission.dead || mission.escaped) return;
    const player = world
      .query({ has: [HorrorPlayer, HorrorStatus, Transform, FpsCamera, Health] })
      .one();
    const responder = world.query({ has: [HorrorThreat, Transform] }).one();
    const ai = responder.get(HorrorThreat);
    ai.warningCooldown = max(0, ai.warningCooldown - 1);
    const status = player.get(HorrorStatus);
    const state = player.get(HorrorPlayer);
    const pos = responder.get(Transform).position;
    const feet = player.get(Transform).position;
    const eye = { ...feet, y: feet.y + player.get(FpsCamera).eyeHeight };
    const grid = gridFor(world);
    if (ai.mode === 'dormant') changeThreat(world, responder, 'patrol', 'horror.threat.awakened');
    const difference = sub3(feet, pos);
    const distance = length3(difference);
    const los = clearSight(grid, { ...pos, y: 1.7 }, eye);
    const facing = dot3(normalize3(difference), { x: ai.facingX, y: 0, z: ai.facingZ });
    const visionRange = state.flashlight ? 12 : state.crouched ? 3.2 : 6;
    const visible =
      los && distance < visionRange && (facing > 0.3 || distance < 1.7 || ai.mode === 'chase');
    const hearingRange = state.noise * (los ? 1 : 0.55);
    const heard =
      hearingRange > 0 &&
      distance < hearingRange &&
      stationPath(grid, pos, feet, Math.floor(hearingRange)) !== undefined;
    if (visible) {
      const previous = ai.suspicion;
      ai.suspicion = min(1, ai.suspicion + dt * (state.crouched && !state.flashlight ? 0.65 : 1.8));
      ai.targetX = feet.x;
      ai.targetZ = feet.z;
      ai.lostTicks = 0;
      if (previous === 0) emit(world, 'horror.threat.suspicious', responder);
      if (ai.suspicion >= 1) {
        changeThreat(world, responder, 'chase', 'horror.threat.chase');
        ai.hadChase = true;
      }
    } else {
      ai.suspicion = max(0, ai.suspicion - dt * 0.45);
      ai.lostTicks++;
    }
    if (heard && ai.mode !== 'chase') {
      changeThreat(world, responder, 'search', 'horror.threat.search');
      ai.targetX = feet.x;
      ai.targetZ = feet.z;
      ai.searchTicks = 360;
    }
    if (ai.mode === 'chase' && ai.lostTicks > 120) {
      changeThreat(world, responder, 'search', 'horror.threat.search');
      ai.searchTicks = 360;
    }
    if (ai.mode === 'search') {
      ai.searchTicks--;
      if (ai.searchTicks <= 0 && !visible) {
        changeThreat(world, responder, 'patrol', 'horror.threat.evaded');
        ai.suspicion = 0;
        ai.hadChase = false;
      }
    }
    if (ai.mode === 'patrol') {
      let waypoint = PATROL[ai.patrolIndex % PATROL.length];
      if (waypoint === undefined) throw new Error('NULL MERIDIAN: empty patrol route');
      if (length3({ x: pos.x - waypoint.x, y: 0, z: pos.z - waypoint.z }) < 0.3) {
        ai.patrolIndex++;
        ai.repathTicks = 0;
        waypoint = PATROL[ai.patrolIndex % PATROL.length];
        if (waypoint === undefined) throw new Error('NULL MERIDIAN: invalid patrol index');
      }
      ai.targetX = waypoint.x;
      ai.targetZ = waypoint.z;
    }
    status.threat =
      ai.mode === 'chase'
        ? 'PURSUIT - break sight, then move quietly.'
        : ai.mode === 'search'
          ? 'SEARCHING - stay out of sight. Light off.'
          : ai.suspicion > 0
            ? 'MOVEMENT DETECTED - get behind solid cover.'
            : 'Listen for the responder.';
    status.threat += ` | Light ${state.flashlight ? 'ON' : 'OFF'} | Sprint ${Math.ceil(state.stamina)}s`;
    status.musicPhase = ai.mode === 'chase' ? 'threat' : mission.uplink ? 'escape' : 'explore';
    if (los && distance < 0.85 && ai.mode === 'chase') {
      if (ai.attackTicks === 0 && ai.warningCooldown === 0) {
        emit(world, 'horror.threat.warning', responder);
        ai.warningCooldown = 120;
      }
      ai.attackTicks++;
      status.threat = 'TOO CLOSE - MOVE NOW';
      if (ai.attackTicks >= 48) {
        mission.dead = true;
        status.ended = true;
        status.musicPhase = 'off';
        status.objective = 'SIGNAL LOST / Restart to return to the docking airlock.';
        status.threat = 'Signal lost. The responder has secured the visitor.';
        player.get(Health).current = 0;
        world.add(player.entity, Dead);
        emit(world, 'player.died', player, { cause: 'responder', attacker: 'responder' });
        say(player, 'Rescue protocol complete. No departure authorized.', tick, 30);
      }
    } else {
      ai.attackTicks = 0;
      moveThreat(world, responder, ai, grid, dt);
    }
  },
};

export const HORROR_SYSTEMS: readonly System[] = [
  locomotionSystem,
  normalizeMovementSystem,
  footstepSystem,
  interactionSystem,
  threatSystem,
];
