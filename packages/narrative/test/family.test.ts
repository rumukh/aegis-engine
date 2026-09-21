import { describe, expect, it } from 'vitest';
import {
  beginHandoff,
  confirmHandoff,
  consumeAbility,
  createFamilyState,
  normalizeAssociationToken,
  parseFamilyState,
  projectFamily,
  restoreFamily,
  selectAssociation,
  validateAssociationGroups,
  validateFamily,
} from '../src/index.js';
import { familyFixture } from './fixtures.js';

describe('trusted local family projections', () => {
  it('requires a neutral confirmation before revealing any private hand', () => {
    const definition = familyFixture(),
      initial = createFamilyState(definition, { questionKey: 'public-question' });
    expect(projectFamily(definition, initial)).toEqual({
      phase: 'handoff',
      nextPlayer: 'p1',
      publicData: { questionKey: 'public-question' },
      stopPrivateNarration: true,
    });
    expect(JSON.stringify(projectFamily(definition, initial))).not.toContain('secret');
    expect(() => confirmHandoff(definition, initial, 'p2', 0)).toThrow(/wrong-player/);
    const first = confirmHandoff(definition, initial, 'p1', 0);
    expect(projectFamily(definition, first)).toMatchObject({
      phase: 'active',
      player: 'p1',
      cards: [{ id: 'private-a', content: { textKey: 'secret-sun' } }],
    });
    expect(JSON.stringify(projectFamily(definition, first))).not.toContain('secret-moon');
    expect(JSON.stringify(projectFamily(definition, first))).not.toContain('secret-star');
    const handoff = beginHandoff(definition, first, 'p2', first.revision);
    expect(JSON.stringify(projectFamily(definition, handoff))).not.toContain('secret');
    expect(() => consumeAbility(definition, handoff, 'p2', 'hint-once')).toThrow(
      /confirmed active/,
    );
    const second = confirmHandoff(definition, handoff, 'p2', handoff.revision);
    expect(second.turn).toBe(1);
    expect(projectFamily(definition, second)).toMatchObject({
      phase: 'active',
      player: 'p2',
      role: 'hint-giver',
      cards: [{ id: 'private-b', content: { textKey: 'secret-moon' } }],
    });
    expect(JSON.stringify(projectFamily(definition, second))).not.toContain('secret-sun');
  });

  it('restores to a neutral handoff without losing turn position or repeating an ability', () => {
    const definition = familyFixture();
    const first = confirmHandoff(definition, createFamilyState(definition), 'p1', 0);
    const consumed = consumeAbility(definition, first, 'p1', 'ask-once');
    expect(consumed.consumed).toBe(true);
    expect(consumed.claimId).toBe('["shared-ribbon","p1","ask-once"]');
    expect(consumeAbility(definition, consumed.state, 'p1', 'ask-once')).toEqual({
      state: consumed.state,
      consumed: false,
      claimId: consumed.claimId,
    });
    const snapshot: unknown = JSON.parse(JSON.stringify(consumed.state));
    expect(parseFamilyState(definition, snapshot)).toEqual(consumed.state);
    const restored = restoreFamily(definition, snapshot);
    expect(restored.phase).toBe('handoff');
    expect(restored.turn).toBe(0);
    expect(JSON.stringify(projectFamily(definition, restored))).not.toContain('secret');
    const confirmed = confirmHandoff(definition, restored, 'p1', restored.revision);
    expect(confirmed.turn).toBe(0);
    expect(consumeAbility(definition, confirmed, 'p1', 'ask-once').consumed).toBe(false);
    expect(first.abilitiesUsed.p1).toEqual([]);
  });

  it('preserves an in-flight handoff through restore and rejects stale confirmations', () => {
    const definition = familyFixture();
    const active = confirmHandoff(definition, createFamilyState(definition), 'p1', 0);
    const handoff = beginHandoff(definition, active, 'p2', 1);
    const restored = restoreFamily(definition, JSON.parse(JSON.stringify(handoff)));
    expect(restored).toEqual(handoff);
    expect(() => confirmHandoff(definition, restored, 'p2', 0)).toThrow(/Stale/);
    expect(confirmHandoff(definition, restored, 'p2', restored.revision).turn).toBe(1);
  });

  it('validates player count, deck capacity and explicit remainder policy', () => {
    const definition = familyFixture();
    expect(createFamilyState(definition).stock).toEqual(['unused']);
    expect(() =>
      validateFamily({ ...definition, players: definition.players.slice(0, 1) }),
    ).toThrow(/at least two/);
    expect(() => validateFamily({ ...definition, remainder: 'reject' })).toThrow(
      /Distribution needs/,
    );
    expect(() =>
      validateFamily({
        ...definition,
        distribution: [{ player: 'p1', count: 3, capacity: 2 }, definition.distribution[1]],
      }),
    ).toThrow(/integer/);
    expect(() =>
      validateFamily({
        ...definition,
        distribution: [
          { player: 'p1', count: 3, capacity: 3 },
          { player: 'p2', count: 2, capacity: 2 },
        ],
      }),
    ).toThrow(/Distribution needs/);
    const state = createFamilyState(definition);
    expect(() => restoreFamily(definition, { ...state, stock: ['private-a'] })).toThrow(
      /Duplicate/,
    );
    expect(() =>
      restoreFamily(definition, { ...state, hands: { p1: [], p2: ['private-a', 'private-b'] } }),
    ).toThrow(/capacity/);
    expect(() => restoreFamily(definition, { ...state, activePlayer: 'p1' })).toThrow(
      /hide the active/,
    );
  });
});

describe('finite approved association hints', () => {
  const policy = {
    answerIds: ['answer-a', 'answer-b'],
    forbiddenTokens: ['ёжик', 'blue box'],
    imageIds: ['moon-image', 'answer-a'],
  };
  const groups = [
    {
      id: 'night',
      tokens: ['moon glow'],
      imageIds: ['moon-image'],
      compatibleAnswerIds: ['answer-a'],
    },
  ];

  it('selects only approved compatible groups without exposing the answer metadata', () => {
    const approved = validateAssociationGroups(groups, policy);
    expect(selectAssociation(approved, 'night', 'answer-a')).toEqual({
      groupId: 'night',
      tokens: ['moon glow'],
      imageIds: ['moon-image'],
    });
    expect(() => selectAssociation(approved, 'night', 'answer-b')).toThrow(/incompatible/);
    expect(() => selectAssociation(approved, 'unknown', 'answer-a')).toThrow(/unknown/);
  });

  it.each(['ЁЖИК!', 'Ежик', 'a BLUE-BOX nearby', 'answer-a', 'ＡＮＳＷＥＲ－Ａ'])(
    'rejects normalized direct token %s',
    (token) => {
      expect(() => validateAssociationGroups([{ ...groups[0], tokens: [token] }], policy)).toThrow(
        /direct-answer token/,
      );
    },
  );

  it('validates images and compatibility while documenting lexical limits', () => {
    expect(normalizeAssociationToken('  ЁЖИК!! ')).toBe('ежик');
    expect(() =>
      validateAssociationGroups([{ ...groups[0], imageIds: ['answer-a'] }], policy),
    ).toThrow(/directly names/);
    expect(() =>
      validateAssociationGroups([{ ...groups[0], imageIds: ['missing'] }], policy),
    ).toThrow(/Unknown reference/);
    expect(() =>
      validateAssociationGroups([{ ...groups[0], compatibleAnswerIds: ['missing'] }], policy),
    ).toThrow(/Unknown reference/);
    expect(
      validateAssociationGroups([{ ...groups[0], tokens: ['spiny animal'] }], policy),
    ).toHaveLength(1);
  });
});
