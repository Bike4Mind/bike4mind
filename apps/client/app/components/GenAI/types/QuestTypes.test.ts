import { QUEST_COMPLEXITY_VALUES } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { Difficulty, DifficultyIcons, getDifficultyColor, toDifficulty } from './QuestTypes';

/**
 * Regression guard for a crash reproduced in a real browser: a quest whose persisted `complexity`
 * was the retired `low` rating took the ENTIRE QuestMaster panel down. `DifficultyIcons['low']` is
 * undefined, and React throws "Element type is invalid" when an undefined value is rendered as a
 * component, which the error boundary catches by blanking the whole feature.
 *
 * `complexity` has no mongoose enum on any write path, so this is not only reachable through
 * legacy data - it stays reachable for anything that writes an unexpected rating.
 */
describe('toDifficulty', () => {
  it('resolves every canonical rating', () => {
    expect(toDifficulty('Easy')).toBe(Difficulty.EASY);
    expect(toDifficulty('Medium')).toBe(Difficulty.MEDIUM);
    expect(toDifficulty('Hard')).toBe(Difficulty.HARD);
  });

  it('resolves the retired lowercase ratings that used to crash the panel', () => {
    expect(toDifficulty('low')).toBe(Difficulty.EASY);
    expect(toDifficulty('medium')).toBe(Difficulty.MEDIUM);
    expect(toDifficulty('high')).toBe(Difficulty.HARD);
  });

  it('always yields a key that DifficultyIcons actually has', () => {
    // The load-bearing assertion. Anything that makes this lookup undefined is the crash.
    for (const complexity of [...QUEST_COMPLEXITY_VALUES, 'low', 'medium', 'high', 'trivial', 'wat', '']) {
      const icon = DifficultyIcons[toDifficulty(complexity)];
      expect(icon).toBeDefined();
      expect(typeof icon).toMatch(/^(function|object)$/);
    }
  });

  it('always yields a difficulty getDifficultyColor can colour', () => {
    // getDifficultyColor's switch has no default arm, so an out-of-enum value returns undefined.
    for (const complexity of ['Easy', 'Hard', 'low', 'high', 'nonsense']) {
      expect(getDifficultyColor(toDifficulty(complexity))).toMatch(/^(success|warning|danger)$/);
    }
  });

  it('falls back to Medium for an undocumented rating rather than returning undefined', () => {
    expect(toDifficulty('trivial')).toBe(Difficulty.MEDIUM);
    expect(toDifficulty('')).toBe(Difficulty.MEDIUM);
  });
});
