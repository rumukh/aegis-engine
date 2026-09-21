import {
  boolean,
  check,
  dictionary,
  id,
  ids,
  integer,
  json,
  list,
  member,
  record,
  reference,
  text,
  unique,
} from './validation.js';
import type { Json } from './validation.js';

export interface FamilyDefinition {
  schema: 1;
  id: string;
  revision: string;
  players: { id: string; labelKey: string; abilities: string[]; role: 'player' | 'hint-giver' }[];
  cards: { id: string; content: Json }[];
  distribution: { player: string; count: number; capacity: number }[];
  remainder: 'stock' | 'reject';
}
export interface FamilyState {
  schema: 1;
  definitionId: string;
  contentRevision: string;
  revision: number;
  turn: number;
  phase: 'handoff' | 'active';
  activePlayer: string | null;
  nextPlayer: string | null;
  advanceTurn: boolean;
  hands: Record<string, string[]>;
  stock: string[];
  abilitiesUsed: Record<string, string[]>;
  publicData: Json;
}
export type FamilyView =
  | { phase: 'handoff'; nextPlayer: string; publicData: Json; stopPrivateNarration: true }
  | {
      phase: 'active';
      player: string;
      role: 'player' | 'hint-giver';
      cards: { id: string; content: Json }[];
      abilities: string[];
      publicData: Json;
    };

export function validateFamily(value: unknown): FamilyDefinition {
  json(value);
  const o = record(value, '$');
  check(o.schema === 1, 'VERSION', '$.schema', 'Unsupported family definition.', 'Use schema 1.');
  const players = list(
    o.players,
    '$.players',
    (v, p) => {
      const player = record(v, p);
      return {
        id: id(player.id, `${p}.id`),
        labelKey: id(player.labelKey, `${p}.labelKey`),
        abilities: ids(player.abilities, `${p}.abilities`, 64),
        role: member(player.role, ['player', 'hint-giver'], `${p}.role`),
      };
    },
    16,
  );
  check(
    players.length >= 2,
    'FAMILY-PLAYERS',
    '$.players',
    'Shared-device play needs at least two players.',
    'Supply 2..16 stable player IDs.',
  );
  unique(
    players.map((p) => p.id),
    '$.players',
  );
  const cards = list(
    o.cards,
    '$.cards',
    (v, p) => {
      const card = record(v, p);
      return { id: id(card.id, `${p}.id`), content: json(card.content, `${p}.content`) };
    },
    1024,
  );
  unique(
    cards.map((c) => c.id),
    '$.cards',
  );
  const distribution = list(
    o.distribution,
    '$.distribution',
    (v, p) => {
      const d = record(v, p);
      const player = id(d.player, `${p}.player`);
      reference(
        player,
        players.map((entry) => entry.id),
        `${p}.player`,
      );
      const capacity = integer(d.capacity, `${p}.capacity`, 0, 1024);
      return { player, capacity, count: integer(d.count, `${p}.count`, 0, capacity) };
    },
    16,
  );
  unique(
    distribution.map((d) => d.player),
    '$.distribution',
  );
  check(
    distribution.length === players.length,
    'FAMILY-DECK',
    '$.distribution',
    'Distribution must name every player.',
    'Declare count and capacity per player.',
  );
  const count = distribution.reduce((sum, d) => sum + d.count, 0);
  const remainder = member(o.remainder, ['stock', 'reject'], '$.remainder');
  check(
    count <= cards.length && (remainder === 'stock' || count === cards.length),
    'FAMILY-DECK',
    '$.distribution',
    `Distribution needs ${count} cards from a deck of ${cards.length}.`,
    'Change counts or explicitly retain remaining cards in stock.',
  );
  return {
    schema: 1,
    id: id(o.id, '$.id'),
    revision: id(o.revision, '$.revision'),
    players,
    cards,
    distribution,
    remainder,
  };
}

export function createFamilyState(input: FamilyDefinition, publicData: Json = null): FamilyState {
  const definition = validateFamily(input);
  const first = definition.players[0];
  check(first, 'FAMILY-PLAYERS', '$.players', 'No first player.', 'Declare players.');
  const hands: Record<string, string[]> = {};
  let offset = 0;
  for (const d of definition.distribution) {
    hands[d.player] = definition.cards.slice(offset, offset + d.count).map((c) => c.id);
    offset += d.count;
  }
  return {
    schema: 1,
    definitionId: definition.id,
    contentRevision: definition.revision,
    revision: 0,
    turn: 0,
    phase: 'handoff',
    activePlayer: null,
    nextPlayer: first.id,
    advanceTurn: false,
    hands,
    stock: definition.cards.slice(offset).map((c) => c.id),
    abilitiesUsed: Object.fromEntries(definition.players.map((p) => [p.id, []])),
    publicData: json(publicData),
  };
}

export function parseFamilyState(input: FamilyDefinition, snapshot: unknown): FamilyState {
  const definition = validateFamily(input);
  json(snapshot);
  const o = record(snapshot, '$');
  check(
    o.schema === 1 && o.definitionId === definition.id && o.contentRevision === definition.revision,
    'RESTORE',
    '$',
    'Family identity or revision mismatch.',
    'Restore against matching content.',
  );
  const state: FamilyState = {
    schema: 1,
    definitionId: definition.id,
    contentRevision: definition.revision,
    revision: integer(o.revision, '$.revision'),
    turn: integer(o.turn, '$.turn'),
    phase: member(o.phase, ['handoff', 'active'], '$.phase'),
    activePlayer: o.activePlayer === null ? null : id(o.activePlayer, '$.activePlayer'),
    nextPlayer: o.nextPlayer === null ? null : id(o.nextPlayer, '$.nextPlayer'),
    advanceTurn: boolean(o.advanceTurn, '$.advanceTurn'),
    hands: dictionary(o.hands, '$.hands', ids),
    stock: ids(o.stock, '$.stock'),
    abilitiesUsed: dictionary(o.abilitiesUsed, '$.abilitiesUsed', ids),
    publicData: json(o.publicData),
  };
  const playerIds = definition.players.map((p) => p.id);
  check(
    Object.keys(state.hands).length === playerIds.length &&
      Object.keys(state.abilitiesUsed).length === playerIds.length,
    'RESTORE',
    '$',
    'Family state must include every player.',
    'Restore all hands and ability ledgers.',
  );
  Object.keys(state.hands).forEach((key) => reference(key, playerIds, '$.hands'));
  Object.keys(state.abilitiesUsed).forEach((key) => reference(key, playerIds, '$.abilitiesUsed'));
  const dealt = [...Object.values(state.hands).flat(), ...state.stock];
  unique(dealt, '$.hands/stock');
  check(
    dealt.length === definition.cards.length,
    'RESTORE',
    '$.hands',
    'Deck is incomplete.',
    'Store every card exactly once.',
  );
  dealt.forEach((key) =>
    reference(
      key,
      definition.cards.map((c) => c.id),
      '$.hands',
    ),
  );
  for (const player of definition.players) {
    const hand = state.hands[player.id],
      used = state.abilitiesUsed[player.id];
    const policy = definition.distribution.find((d) => d.player === player.id);
    check(
      hand && used && policy && hand.length <= policy.capacity,
      'RESTORE',
      player.id,
      'Invalid hand capacity or ability ledger.',
      'Use a hand within the declared capacity and include ability usage.',
    );
    used.forEach((key) => reference(key, player.abilities, `abilitiesUsed.${player.id}`));
  }
  if (state.phase === 'handoff') {
    check(
      state.activePlayer === null && state.nextPlayer !== null,
      'RESTORE',
      '$.phase',
      'Handoff must hide the active player view.',
      'Store only the next player identity during handoff.',
    );
    reference(state.nextPlayer, playerIds, '$.nextPlayer');
  } else {
    check(
      state.activePlayer !== null && state.nextPlayer === null && !state.advanceTurn,
      'RESTORE',
      '$.phase',
      'Active player state is inconsistent.',
      'Finish the explicit handoff first.',
    );
    reference(state.activePlayer, playerIds, '$.activePlayer');
  }
  return state;
}

/** Disk restore always returns a neutral handoff, even when the save was taken mid-turn. */
export function restoreFamily(input: FamilyDefinition, snapshot: unknown): FamilyState {
  const state = parseFamilyState(input, snapshot);
  return state.phase === 'handoff'
    ? state
    : {
        ...state,
        phase: 'handoff',
        nextPlayer: state.activePlayer,
        activePlayer: null,
        advanceTurn: false,
      };
}

export function beginHandoff(
  input: FamilyDefinition,
  snapshot: FamilyState,
  nextPlayer: string,
  revision: number,
): FamilyState {
  const state = parseFamilyState(input, snapshot);
  check(
    revision === state.revision && state.phase === 'active',
    'FAMILY-HANDOFF',
    '$',
    'Stale handoff or no confirmed active player.',
    'Confirm the current player before handing off.',
  );
  reference(
    nextPlayer,
    input.players.map((p) => p.id),
    '$.nextPlayer',
  );
  check(
    nextPlayer !== state.activePlayer,
    'FAMILY-HANDOFF',
    '$.nextPlayer',
    'Next turn must belong to another player.',
    'Select a different local player.',
  );
  return {
    ...state,
    phase: 'handoff',
    activePlayer: null,
    nextPlayer,
    advanceTurn: true,
    revision: integer(state.revision + 1, '$.revision'),
  };
}

export function confirmHandoff(
  input: FamilyDefinition,
  snapshot: FamilyState,
  player: string,
  revision: number,
): FamilyState {
  const state = parseFamilyState(input, snapshot);
  check(
    revision === state.revision && state.phase === 'handoff' && state.nextPlayer === player,
    'FAMILY-HANDOFF',
    '$',
    'Stale or wrong-player handoff confirmation.',
    'Let the named next player confirm the neutral screen.',
  );
  return {
    ...state,
    phase: 'active',
    activePlayer: player,
    nextPlayer: null,
    turn: integer(state.turn + (state.advanceTurn ? 1 : 0), '$.turn'),
    advanceTurn: false,
    revision: integer(state.revision + 1, '$.revision'),
  };
}

export function consumeAbility(
  input: FamilyDefinition,
  snapshot: FamilyState,
  player: string,
  ability: string,
): { state: FamilyState; consumed: boolean; claimId: string } {
  const state = parseFamilyState(input, snapshot);
  check(
    state.phase === 'active' && state.activePlayer === player,
    'FAMILY-ABILITY',
    '$.player',
    'Only the confirmed active player can use an ability.',
    'Confirm the handoff before using an ability.',
  );
  const person = input.players.find((p) => p.id === player);
  check(person, 'REFERENCE', player, 'Unknown player.', 'Use a declared player.');
  reference(ability, person.abilities, '$.ability');
  const used = state.abilitiesUsed[player];
  check(used, 'RESTORE', player, 'Missing ability ledger.', 'Restore all players.');
  const claimId = JSON.stringify([state.definitionId, player, ability]);
  if (used.includes(ability)) return { state, consumed: false, claimId };
  used.push(ability);
  state.revision = integer(state.revision + 1, '$.revision');
  return { state, consumed: true, claimId };
}

export function projectFamily(input: FamilyDefinition, snapshot: FamilyState): FamilyView {
  const state = parseFamilyState(input, snapshot);
  if (state.phase === 'handoff') {
    check(
      state.nextPlayer,
      'RESTORE',
      '$.nextPlayer',
      'Missing handoff recipient.',
      'Restore a valid handoff.',
    );
    return {
      phase: 'handoff',
      nextPlayer: state.nextPlayer,
      publicData: json(state.publicData),
      stopPrivateNarration: true,
    };
  }
  const player = input.players.find((p) => p.id === state.activePlayer);
  check(player, 'RESTORE', '$.activePlayer', 'Missing active player.', 'Restore a valid player.');
  return {
    phase: 'active',
    player: player.id,
    role: player.role,
    cards: input.cards
      .filter((c) => state.hands[player.id]?.includes(c.id))
      .map((c) => ({ id: c.id, content: json(c.content) })),
    abilities: player.abilities.filter((key) => !state.abilitiesUsed[player.id]?.includes(key)),
    publicData: json(state.publicData),
  };
}

export interface AssociationGroup {
  id: string;
  tokens: string[];
  imageIds: string[];
  compatibleAnswerIds: string[];
}

export function normalizeAssociationToken(value: string): string {
  return text(value, '$.token')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function validateAssociationGroups(
  input: unknown,
  policy: { answerIds: string[]; forbiddenTokens: string[]; imageIds: string[] },
): AssociationGroup[] {
  const answers = ids(policy.answerIds, '$.policy.answerIds');
  const images = ids(policy.imageIds, '$.policy.imageIds');
  const forbidden = [
    ...answers,
    ...list(policy.forbiddenTokens, '$.policy.forbiddenTokens', text),
  ].map(normalizeAssociationToken);
  const groups = list(input, '$.groups', (value, path) => {
    const o = record(value, path);
    const tokens = list(o.tokens, `${path}.tokens`, text, 64);
    const imageIds = ids(o.imageIds, `${path}.imageIds`, 64);
    const compatibleAnswerIds = ids(o.compatibleAnswerIds, `${path}.compatibleAnswerIds`, 128);
    check(
      tokens.length + imageIds.length > 0 && compatibleAnswerIds.length > 0,
      'ASSOCIATION',
      path,
      'Empty association or compatibility set.',
      'Author finite approved tokens/images and compatible answers.',
    );
    for (const token of tokens) {
      const normalized = normalizeAssociationToken(token);
      check(
        normalized.length > 0 &&
          !forbidden.some((word) => word.length > 0 && ` ${normalized} `.includes(` ${word} `)),
        'ASSOCIATION-DIRECT',
        path,
        'Association contains a declared direct-answer token.',
        'Use an approved indirect association; this is lexical validation, not semantic censorship.',
      );
    }
    imageIds.forEach((key) => reference(key, images, path));
    check(
      !imageIds.some((key) => answers.includes(key)),
      'ASSOCIATION-DIRECT',
      path,
      'An image ID directly names an answer.',
      'Use distinct approved association image IDs.',
    );
    compatibleAnswerIds.forEach((key) => reference(key, answers, path));
    return { id: id(o.id, `${path}.id`), tokens, imageIds, compatibleAnswerIds };
  });
  unique(
    groups.map((g) => g.id),
    '$.groups',
  );
  return groups;
}

export function selectAssociation(
  groups: readonly AssociationGroup[],
  groupId: string,
  answerId: string,
): { groupId: string; tokens: string[]; imageIds: string[] } {
  const group = groups.find((g) => g.id === groupId);
  check(
    group && group.compatibleAnswerIds.includes(answerId),
    'ASSOCIATION',
    '$.group',
    'Association is unknown or incompatible.',
    'Select a validated approved group for this answer.',
  );
  return { groupId: group.id, tokens: [...group.tokens], imageIds: [...group.imageIds] };
}
