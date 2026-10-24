import { describe, it, expect, vi } from 'vitest';
import { importHistoryJobRepository } from './ImportHistoryJobModel';

// Spied rather than run against mongod: the contract is the shape of the `$set`, and MongoDB
// silently drops an `undefined` value, so a real write cannot tell "omitted" from "written as
// undefined" - which is exactly the difference the optional field has to preserve.
const spyOnUpdateOne = () =>
  vi.spyOn(importHistoryJobRepository.model, 'updateOne').mockResolvedValue({ acknowledged: true } as never);

const setOf = (spy: ReturnType<typeof spyOnUpdateOne>) =>
  (spy.mock.calls[0][1] as { $set: Record<string, unknown> }).$set;

describe('ImportHistoryJobRepository.markComplete', () => {
  it('writes processedItems and totalItems together', async () => {
    const spy = spyOnUpdateOne();
    try {
      await importHistoryJobRepository.markComplete('job-1', { processedItems: 5, skippedItems: 0, totalItems: 5 });

      const set = setOf(spy);
      expect(set.processedItems).toBe(5);
      expect(set.totalItems).toBe(5);
      expect(set.status).toBe('completed');
    } finally {
      spy.mockRestore();
    }
  });

  it('omits totalItems when the caller does not supply it', async () => {
    const spy = spyOnUpdateOne();
    try {
      await importHistoryJobRepository.markComplete('job-2', { processedItems: 3, skippedItems: 1 });

      expect(setOf(spy)).not.toHaveProperty('totalItems');
    } finally {
      spy.mockRestore();
    }
  });
});
