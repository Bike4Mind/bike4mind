import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY,
  ANSWER_FEEDBACK_DISMISSED_TURNS_KEY,
  DAILY_DISMISSAL_BUDGET,
  dismissAnswerFeedbackPrompt,
  isAnswerFeedbackPromptCapped,
  isAnswerFeedbackPromptDismissed,
} from './answerFeedbackPrompt';

const spendBudget = () => {
  for (let i = 0; i < DAILY_DISMISSAL_BUDGET; i++) {
    dismissAnswerFeedbackPrompt(`quest-${i}`);
  }
};

describe('answerFeedbackPrompt frequency control', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('per-turn dismissal', () => {
    it('reports not dismissed for an untouched turn', () => {
      expect(isAnswerFeedbackPromptDismissed('quest-1')).toBe(false);
    });

    it('remembers a dismissal, scoped to that turn', () => {
      dismissAnswerFeedbackPrompt('quest-1');
      expect(isAnswerFeedbackPromptDismissed('quest-1')).toBe(true);
      expect(isAnswerFeedbackPromptDismissed('quest-2')).toBe(false);
    });

    it('caps stored turns and drops the oldest first', () => {
      for (let i = 0; i < 205; i++) {
        dismissAnswerFeedbackPrompt(`quest-${i}`);
      }
      expect(JSON.parse(localStorage.getItem(ANSWER_FEEDBACK_DISMISSED_TURNS_KEY)!)).toHaveLength(200);
      expect(isAnswerFeedbackPromptDismissed('quest-0')).toBe(false);
      expect(isAnswerFeedbackPromptDismissed('quest-204')).toBe(true);
    });
  });

  describe('daily budget', () => {
    it('does not cap before the budget is spent', () => {
      for (let i = 0; i < DAILY_DISMISSAL_BUDGET - 1; i++) {
        dismissAnswerFeedbackPrompt(`quest-${i}`);
      }
      expect(isAnswerFeedbackPromptCapped()).toBe(false);
    });

    it('caps once the budget is spent', () => {
      spendBudget();
      expect(isAnswerFeedbackPromptCapped()).toBe(true);
    });

    it('does not spend the budget twice for the same turn', () => {
      // A remount that re-dismisses an already-dismissed turn must not silently burn the day.
      for (let i = 0; i < DAILY_DISMISSAL_BUDGET + 2; i++) {
        dismissAnswerFeedbackPrompt('quest-1');
      }
      expect(isAnswerFeedbackPromptCapped()).toBe(false);
      expect(JSON.parse(localStorage.getItem(ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY)!).count).toBe(1);
    });

    it('resets on the next local day', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 16, 23, 30));
      spendBudget();
      expect(isAnswerFeedbackPromptCapped()).toBe(true);

      vi.setSystemTime(new Date(2026, 8, 17, 0, 30));
      expect(isAnswerFeedbackPromptCapped()).toBe(false);
    });

    it('keeps a turn dismissed across the day rollover', () => {
      // The two layers are independent: yesterday's budget resets, yesterday's declines do not.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 8, 16, 23, 30));
      dismissAnswerFeedbackPrompt('quest-1');

      vi.setSystemTime(new Date(2026, 8, 17, 0, 30));
      expect(isAnswerFeedbackPromptDismissed('quest-1')).toBe(true);
    });
  });

  describe('storage failure', () => {
    it('degrades to not-dismissed and not-capped rather than throwing', () => {
      spendBudget();
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });

      expect(isAnswerFeedbackPromptDismissed('quest-0')).toBe(false);
      expect(isAnswerFeedbackPromptCapped()).toBe(false);
    });

    it('survives a write failure', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      expect(() => dismissAnswerFeedbackPrompt('quest-1')).not.toThrow();
    });

    it('ignores a corrupt payload rather than throwing', () => {
      localStorage.setItem(ANSWER_FEEDBACK_DISMISSED_TURNS_KEY, '{"not":"an array"}');
      localStorage.setItem(ANSWER_FEEDBACK_DAILY_DISMISSALS_KEY, 'not json at all');

      expect(isAnswerFeedbackPromptDismissed('quest-1')).toBe(false);
      expect(isAnswerFeedbackPromptCapped()).toBe(false);
    });
  });
});
