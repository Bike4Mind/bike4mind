import { describe, expect, it } from 'vitest';
import { DEFAULT_FEEDBACK_VIEW, feedbackViewFromSearch, feedbackViewToSearch } from './feedbackTabSearch';

describe('feedback label filters', () => {
  it('round trips area and severity in shared view URLs', () => {
    const view = { ...DEFAULT_FEEDBACK_VIEW, area: 'chat' as const, severity: 'blocking' as const };
    expect(feedbackViewFromSearch(feedbackViewToSearch(view))).toMatchObject({ area: 'chat', severity: 'blocking' });
  });
  it('drops unknown taxonomy values', () => {
    expect(feedbackViewFromSearch({ feedbackArea: 'invented', feedbackSeverity: 'urgent' })).toMatchObject({
      area: undefined,
      severity: undefined,
    });
  });
});
