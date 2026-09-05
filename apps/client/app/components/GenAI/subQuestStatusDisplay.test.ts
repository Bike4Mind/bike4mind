import { SUBQUEST_STATUS_VALUES } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import { getSubQuestStatusColor } from './subQuestStatusDisplay';

describe('getSubQuestStatusColor', () => {
  it('returns a colour for every canonical status', () => {
    for (const status of SUBQUEST_STATUS_VALUES) {
      expect(getSubQuestStatusColor(status)).toMatch(/^(success|warning|neutral|danger)$/);
    }
  });

  it('keeps the colours the previous switch produced for canonical statuses', () => {
    // Pinning the pre-refactor output exactly: this extraction must not smuggle in a visual
    // change, including for `deleted`, which the old switch coloured via its default arm.
    expect(getSubQuestStatusColor('completed')).toBe('success');
    expect(getSubQuestStatusColor('in_progress')).toBe('warning');
    expect(getSubQuestStatusColor('not_started')).toBe('neutral');
    expect(getSubQuestStatusColor('skipped')).toBe('neutral');
    expect(getSubQuestStatusColor('deleted')).toBe('neutral');
  });

  it('colours a retired hyphenated status like its canonical twin', () => {
    // The bug the old local alias list had: it handled `pending` but not `in-progress`, so a
    // legacy in-progress row rendered grey while an identical underscore row rendered orange.
    expect(getSubQuestStatusColor('in-progress')).toBe('warning');
    expect(getSubQuestStatusColor('in-progress')).toBe(getSubQuestStatusColor('in_progress'));
  });

  it('colours the other retired tokens as their canonical meaning', () => {
    expect(getSubQuestStatusColor('pending')).toBe('neutral');
    expect(getSubQuestStatusColor('blocked')).toBe('neutral');
  });

  it('falls back to neutral for a token with no documented meaning', () => {
    for (const unknown of ['done', 'started', 'failed', 'error', 'wat', '']) {
      expect(getSubQuestStatusColor(unknown)).toBe('neutral');
    }
  });
});
