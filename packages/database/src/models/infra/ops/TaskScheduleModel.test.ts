import { describe, it, expect } from 'vitest';
import { TaskScheduleStatus, TaskScheduleHandler } from '@bike4mind/common';
import { taskScheduleRepository } from './TaskScheduleModel';
import { setupMongoTest } from '../../../__test__/utils';

describe('TaskScheduleRepository', () => {
  setupMongoTest();

  const now = new Date();
  const LEASE_TTL_MS = 30 * 60 * 1000;
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

  const claim = () => taskScheduleRepository.claimDueTaskSchedule(new Date(), new Date(Date.now() - LEASE_TTL_MS));

  it('claims a due pending task and leaves a future-dated one alone', async () => {
    const due = await taskScheduleRepository.create(createTaskData({ processDate: new Date(now.getTime() - 10000) }));
    await taskScheduleRepository.create(createTaskData({ processDate: new Date(now.getTime() + 10000) }));

    const claimed = await claim();

    expect(claimed?.id).toBe(due.id);
    expect(claimed?.status).toBe(TaskScheduleStatus.PROCESSING);
    expect(claimed?.claimedAt).toBeInstanceOf(Date);
    expect(await claim()).toBeNull();
  });

  it('hands the same due task to exactly one of two concurrent claimers', async () => {
    await taskScheduleRepository.create(createTaskData());

    const [first, second] = await Promise.all([claim(), claim()]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('does not reclaim a task whose lease is still live', async () => {
    await taskScheduleRepository.create(
      createTaskData({ status: TaskScheduleStatus.PROCESSING, claimedAt: new Date(Date.now() - 60_000) })
    );

    expect(await claim()).toBeNull();
  });

  it('reclaims a task whose lease has expired', async () => {
    const stale = await taskScheduleRepository.create(
      createTaskData({
        status: TaskScheduleStatus.PROCESSING,
        claimedAt: new Date(Date.now() - LEASE_TTL_MS - 60_000),
      })
    );

    const claimed = await claim();

    expect(claimed?.id).toBe(stale.id);
    expect(claimed?.claimedAt?.getTime()).toBeGreaterThan(Date.now() - LEASE_TTL_MS);
  });

  it('reclaims a processing task that carries no claim stamp', async () => {
    const stamped = await taskScheduleRepository.create(createTaskData({ status: TaskScheduleStatus.PROCESSING }));

    expect((await claim())?.id).toBe(stamped.id);
  });

  it('does not claim a task in a terminal status', async () => {
    await taskScheduleRepository.create(createTaskData({ status: TaskScheduleStatus.COMPLETED }));
    await taskScheduleRepository.create(createTaskData({ status: TaskScheduleStatus.FAILED }));

    expect(await claim()).toBeNull();
  });
});
