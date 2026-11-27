import { describe, expect, it } from 'vitest';
import { apiCompletionObservationSchema } from './completionSynchrony';

const base = {
  requestId: 'synthetic-request',
  requestedModel: 'model-alpha',
  startedAt: '2026-11-19T00:00:00.000Z',
  outcome: 'failed',
};

describe('apiCompletionObservationSchema failureCode', () => {
  it('accepts a short identifier and its absence', () => {
    expect(apiCompletionObservationSchema.safeParse({ ...base, failureCode: 'http_503' }).success).toBe(true);
    expect(apiCompletionObservationSchema.safeParse(base).success).toBe(true);
  });

  it.each(['has space', 'x'.repeat(65), '', 'bad/char'])('rejects %j', failureCode => {
    expect(apiCompletionObservationSchema.safeParse({ ...base, failureCode }).success).toBe(false);
  });
});
