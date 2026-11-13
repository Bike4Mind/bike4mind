import { describe, expect, it } from 'vitest';
import { FeedbackBulkSelectionSchema } from './feedbackBulk';

const allMatching = (filters: Record<string, unknown>) =>
  FeedbackBulkSelectionSchema.safeParse({ mode: 'allMatching', filters });

describe('FeedbackBulkSelectionSchema', () => {
  it('accepts the custom range and comment filters the list sends', () => {
    const parsed = allMatching({
      createdFrom: '2026-11-01T00:00:00.000Z',
      createdTo: '2026-11-08T23:59:59.999Z',
      hasComment: false,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an inverted range', () => {
    const parsed = allMatching({ createdFrom: '2026-11-09T00:00:00.000Z', createdTo: '2026-11-08T23:59:59.999Z' });
    expect(parsed.success).toBe(false);
  });
});
