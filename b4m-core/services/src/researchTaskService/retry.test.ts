import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { retry } from './retry';
import { ResearchTaskStatus } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { mockResearchTask } from '../__tests__/utils/testUtils';

describe('researchTaskService - retry', () => {
  let mockRepo: { findByIdAndUserId: Mock; update: Mock };
  let mockProcess: Mock;
  let adapters: any;

  beforeEach(() => {
    mockRepo = { findByIdAndUserId: vi.fn(), update: vi.fn() };
    mockProcess = vi.fn();
    adapters = {
      db: {
        transaction: async <T>(fn: () => Promise<T>) => fn(),
        researchTasks: mockRepo,
      },
      jobs: { researchTasks: { process: mockProcess } },
    };
  });

  it('writes only the reset fields, then enqueues processing', async () => {
    const task = mockResearchTask({
      id: 'task-1',
      status: ResearchTaskStatus.FAILED,
      statusFailedAt: new Date('2026-01-01T00:00:00.000Z'),
      statusFailedMessage: 'boom',
    });
    mockRepo.findByIdAndUserId.mockResolvedValue(task);

    await retry({ id: 'task-1', userId: 'user-1' }, adapters);

    expect(mockRepo.update).toHaveBeenCalledTimes(1);
    expect(mockRepo.update.mock.calls[0][0]).toStrictEqual({
      id: 'task-1',
      status: ResearchTaskStatus.PROCESSING,
      statusFailedAt: null,
      statusFailedMessage: null,
    });
    expect(mockProcess).toHaveBeenCalledTimes(1);
    expect(mockProcess).toHaveBeenCalledWith('task-1', 'user-1');
    expect(mockRepo.update.mock.invocationCallOrder[0]).toBeLessThan(mockProcess.mock.invocationCallOrder[0]);
  });

  it('throws NotFoundError without writing or enqueueing when the task is missing', async () => {
    mockRepo.findByIdAndUserId.mockResolvedValue(null);

    await expect(retry({ id: 'task-1', userId: 'user-1' }, adapters)).rejects.toThrow(NotFoundError);

    expect(mockRepo.update).not.toHaveBeenCalled();
    expect(mockProcess).not.toHaveBeenCalled();
  });
});
