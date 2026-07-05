import { describe, it, expect } from 'vitest';
import { TaskScheduleStatus, TaskScheduleHandler } from '@bike4mind/common';
import { taskScheduleRepository } from './TaskScheduleModel';
import { setupMongoTest } from '../../../__test__/utils';

describe('TaskScheduleRepository', () => {
  setupMongoTest();

  const now = new Date();
  const baseTaskData = {
    handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
    payload: { id: 'foo', userId: 'bar' },
    status: TaskScheduleStatus.PENDING,
    processDate: new Date(now.getTime() - 1000),
    createdAt: now,
    updatedAt: now,
  };

  function createTaskData(overrides = {}) {
    return { ...baseTaskData, ...overrides };
  }

  it('should find all pending tasks by processDate', async () => {
    const oldDate = new Date(now.getTime() - 10000);
    await taskScheduleRepository.create(createTaskData({ processDate: oldDate, status: TaskScheduleStatus.PENDING }));
    await taskScheduleRepository.create(
      createTaskData({ processDate: new Date(now.getTime() + 10000), status: TaskScheduleStatus.PENDING })
    );
    const found = await taskScheduleRepository.findAllStatusPendingByProcessDateLessThan(new Date());
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0]?.status).toBe(TaskScheduleStatus.PENDING);
    expect(found[0]?.processDate?.getTime()).toBeLessThan(new Date().getTime());
  });
});
