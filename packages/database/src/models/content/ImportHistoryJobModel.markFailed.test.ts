import { describe, it, expect, vi } from 'vitest';
import { importHistoryJobRepository } from './ImportHistoryJobModel';

const spyOnUpdateOne = () =>
  vi.spyOn(importHistoryJobRepository.model, 'updateOne').mockResolvedValue({ acknowledged: true } as never);

describe('ImportHistoryJobRepository.markFailed', () => {
  it('persists the failed step alongside the status and error details', async () => {
    const spy = spyOnUpdateOne();
    try {
      await importHistoryJobRepository.markFailed('job-1', { message: 'boom', stack: 'Error: boom\n    at x' });

      const [filter, update] = spy.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
      expect(filter).toEqual({ _id: 'job-1' });
      expect(update.$set).toMatchObject({
        status: 'failed',
        currentStep: 'Import failed',
        errorMessage: 'boom',
        errorStack: 'Error: boom\n    at x',
      });
      expect(update.$set.failedAt).toBeInstanceOf(Date);
    } finally {
      spy.mockRestore();
    }
  });
});
