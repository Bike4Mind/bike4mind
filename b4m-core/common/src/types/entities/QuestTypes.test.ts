import { describe, expect, it } from 'vitest';
import {
  LEGACY_QUEST_COMPLEXITY_ALIASES,
  LEGACY_SUBQUEST_STATUS_ALIASES,
  QUEST_COMPLEXITY_VALUES,
  SUBQUEST_STATUS_VALUES,
  normalizeQuestComplexity,
  normalizeSubQuestStatus,
} from './QuestTypes';

describe('normalizeSubQuestStatus', () => {
  it('passes every canonical value through unchanged', () => {
    for (const status of SUBQUEST_STATUS_VALUES) {
      expect(normalizeSubQuestStatus(status)).toBe(status);
    }
  });

  it('maps every retired token to a canonical value', () => {
    // Iterating the map rather than restating it: adding an alias without a canonical target
    // fails here instead of at the point a migration writes it.
    for (const [legacy, canonical] of Object.entries(LEGACY_SUBQUEST_STATUS_ALIASES)) {
      expect(normalizeSubQuestStatus(legacy)).toBe(canonical);
      expect(SUBQUEST_STATUS_VALUES).toContain(canonical);
    }
  });

  it('resolves the three divergences the unification was about', () => {
    expect(normalizeSubQuestStatus('in-progress')).toBe('in_progress');
    expect(normalizeSubQuestStatus('pending')).toBe('not_started');
    expect(normalizeSubQuestStatus('blocked')).toBe('not_started');
  });

  it('returns null rather than a default for a token nobody documented', () => {
    // The load-bearing contract. A default here would let a migration rewrite rows whose meaning
    // is unknown, and would make an unreadable row look like a genuinely-unstarted one.
    expect(normalizeSubQuestStatus('done')).toBeNull();
    expect(normalizeSubQuestStatus('started')).toBeNull();
    expect(normalizeSubQuestStatus('failed')).toBeNull();
    expect(normalizeSubQuestStatus('totally-made-up')).toBeNull();
  });

  it('returns null for a token naming an Object.prototype member', () => {
    // The alias tables are plain object literals, so `ALIASES[value] ?? null` returned the
    // INHERITED member for these - a function, typed as a SubQuestStatus. The migration writes
    // whatever this returns straight to the database through the raw driver, so `constructor`
    // on disk would have been rewritten to a function and `__proto__` to `{}`, onto a
    // `required: true` String path.
    for (const hostile of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__']) {
      expect(normalizeSubQuestStatus(hostile)).toBeNull();
      expect(normalizeQuestComplexity(hostile)).toBeNull();
    }
  });

  it('returns null for every non-string shape a mongo document can hold', () => {
    for (const value of [undefined, null, 42, true, {}, [], new Date()]) {
      expect(normalizeSubQuestStatus(value)).toBeNull();
    }
  });

  it('is case-sensitive - a cased variant is unknown, not silently accepted', () => {
    // Deliberate: no reader or writer has ever produced a cased status, so accepting one would
    // be inventing an alias. If cased data ever turns up, it gets a documented entry.
    expect(normalizeSubQuestStatus('In_Progress')).toBeNull();
    expect(normalizeSubQuestStatus('COMPLETED')).toBeNull();
  });

  it('never maps a retired token onto another retired token', () => {
    for (const canonical of Object.values(LEGACY_SUBQUEST_STATUS_ALIASES)) {
      expect(LEGACY_SUBQUEST_STATUS_ALIASES[canonical]).toBeUndefined();
    }
  });

  it('claims no canonical value as a legacy alias', () => {
    // A canonical value appearing as an alias key would make the alias unreachable and the map
    // self-contradictory.
    for (const status of SUBQUEST_STATUS_VALUES) {
      expect(LEGACY_SUBQUEST_STATUS_ALIASES[status]).toBeUndefined();
    }
  });
});

describe('normalizeQuestComplexity', () => {
  it('passes every canonical rating through unchanged', () => {
    for (const complexity of QUEST_COMPLEXITY_VALUES) {
      expect(normalizeQuestComplexity(complexity)).toBe(complexity);
    }
  });

  it('maps every retired rating to a canonical one', () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_QUEST_COMPLEXITY_ALIASES)) {
      expect(normalizeQuestComplexity(legacy)).toBe(canonical);
      expect(QUEST_COMPLEXITY_VALUES).toContain(canonical);
    }
  });

  it('does not treat a canonical rating as its own lowercase alias by accident', () => {
    // 'medium' -> 'Medium' is an alias; 'Medium' must still resolve directly, not via the map.
    expect(normalizeQuestComplexity('Medium')).toBe('Medium');
    expect(normalizeQuestComplexity('medium')).toBe('Medium');
  });

  it('returns null for an undocumented rating', () => {
    expect(normalizeQuestComplexity('trivial')).toBeNull();
    expect(normalizeQuestComplexity('expert')).toBeNull();
    expect(normalizeQuestComplexity(undefined)).toBeNull();
  });
});
