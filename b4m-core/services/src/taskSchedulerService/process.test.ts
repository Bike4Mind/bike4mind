import { describe, it, expect, vi, beforeEach } from 'vitest';
import { process } from './process';
import { TaskScheduleStatus, TaskScheduleHandler } from '@bike4mind/common';

const mockHandler = vi.fn();
const mockLogger = { info: vi.fn(), error: vi.fn() };

const now = new Date('2024-01-01T00:00:00Z');
vi.setSystemTime(now);

const LEASE_TTL_MS = 30 * 60 * 1000;

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
  payload: { id: 'foo', userId: 'bar' },
  status: TaskScheduleStatus.PENDING,
  createdAt: now,
  updatedAt: now,
  processDate: new Date(now.getTime() - 1000),
  ...overrides,
});

/**
 * Stands in for TaskScheduleRepository. `claimDueTaskSchedule` yields before selecting so that
 * concurrent callers genuinely interleave, then does its check-and-set without another await:
 * the same all-or-nothing guarantee Mongo's findOneAndUpdate gives the real repository.
 */
const setup = (tasks: ReturnType<typeof makeTask>[]) => {
  const rows = tasks.map(task => ({ ...task }) as Record<string, any>);

  const taskSchedules = {
    claimDueTaskSchedule: vi.fn(async (dueBefore: Date, leaseExpiredBefore: Date) => {
      await Promise.resolve();
      const row = rows.find(
        candidate =>
          candidate.processDate < dueBefore &&
          (candidate.status === TaskScheduleStatus.PENDING ||
            (candidate.status === TaskScheduleStatus.PROCESSING &&
              (candidate.claimedAt == null || candidate.claimedAt < leaseExpiredBefore)))
      );
      if (!row) {
        return null;
      }
      row.status = TaskScheduleStatus.PROCESSING;
      row.claimedAt = new Date();
      return { ...row };
    }),
    update: vi.fn(async (data: Record<string, any>) => {
      await Promise.resolve();
      const row = rows.find(candidate => candidate.id === data.id);
      if (row) {
        Object.assign(row, data);
      }
      return row ?? null;
    }),
  };

  const updateFor = (id: string) =>
    taskSchedules.update.mock.calls.map(([arg]) => arg).find(arg => arg.id === id) as Record<string, any> | undefined;

  return { db: { taskSchedules } as any, rows, updateFor, taskSchedules };
};

describe('taskSchedulerService/process', () => {
  let handlers: any;

  beforeEach(() => {
    mockHandler.mockReset();
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
    handlers = {
      [TaskScheduleHandler.RESEARCH_TASK_PROCESS]: mockHandler,
    };
  });

  it('sets expireAt when task is COMPLETED', async () => {
    const { db, updateFor } = setup([makeTask()]);
    mockHandler.mockResolvedValue(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(updateFor('task-1')).toMatchObject({
      status: TaskScheduleStatus.COMPLETED,
      statusCompletedAt: now,
      expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  it('sets expireAt when task is FAILED', async () => {
    const { db, updateFor } = setup([makeTask()]);
    handlers[TaskScheduleHandler.RESEARCH_TASK_PROCESS] = vi.fn(() => {
      throw new Error('fail');
    });

    await process({ db, logger: mockLogger, handlers });

    expect(updateFor('task-1')).toMatchObject({
      status: TaskScheduleStatus.FAILED,
      statusFailedAt: now,
      expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  it('holds the claim without a terminal status until its asynchronous handler resolves', async () => {
    const { db, rows, taskSchedules } = setup([makeTask()]);
    let resolveHandler!: () => void;
    mockHandler.mockReturnValueOnce(
      new Promise<void>(resolve => {
        resolveHandler = resolve;
      })
    );

    const processing = process({ db, logger: mockLogger, handlers });
    await vi.waitFor(() => expect(mockHandler).toHaveBeenCalledOnce());
    expect(rows[0]!.status).toBe(TaskScheduleStatus.PROCESSING);
    expect(rows[0]!.claimedAt).toEqual(now);
    expect(taskSchedules.update).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalledWith('Finished processing task schedules');

    resolveHandler();
    await processing;
    expect(taskSchedules.update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: TaskScheduleStatus.COMPLETED,
        statusCompletedAt: now,
      })
    );
  });

  it('persists asynchronous failure and still completes the other due schedule', async () => {
    const { db, updateFor } = setup([
      makeTask({ payload: { id: 'boom', userId: 'bar' } }),
      makeTask({ id: 'task-2', payload: { id: 'ok', userId: 'bar' } }),
    ]);
    const error = new Error('Queue unavailable');
    mockHandler.mockImplementation((payload: any) =>
      payload.id === 'boom' ? Promise.reject(error) : Promise.resolve()
    );

    await process({ db, logger: mockLogger, handlers });

    expect(updateFor('task-1')).toMatchObject({
      status: TaskScheduleStatus.FAILED,
      statusFailedAt: now,
      statusFailedReason: 'Queue unavailable',
      expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    expect(updateFor('task-1')).not.toHaveProperty('statusCompletedAt');
    expect(updateFor('task-2')).toMatchObject({ status: TaskScheduleStatus.COMPLETED });
    expect(mockLogger.error).toHaveBeenCalledWith('Error processing task schedule: task-1', error);
  });

  it('still completes a handler that returns synchronously', async () => {
    const { db, taskSchedules } = setup([makeTask()]);
    mockHandler.mockReturnValueOnce(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(taskSchedules.update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        status: TaskScheduleStatus.COMPLETED,
      })
    );
  });

  it('does nothing if there are no due tasks', async () => {
    const { db, taskSchedules } = setup([]);

    await process({ db, logger: mockLogger, handlers });

    expect(taskSchedules.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Processed 0 task schedules');
    expect(mockLogger.info).toHaveBeenCalledWith('Finished processing task schedules');
  });

  it('leaves a schedule that is not yet due alone', async () => {
    const { db, taskSchedules } = setup([makeTask({ processDate: new Date(now.getTime() + 60_000) })]);

    await process({ db, logger: mockLogger, handlers });

    expect(mockHandler).not.toHaveBeenCalled();
    expect(taskSchedules.update).not.toHaveBeenCalled();
  });

  it('sets task to FAILED if handler is not found', async () => {
    const { db, updateFor } = setup([makeTask({ handler: 'UNKNOWN_HANDLER' })]);

    await process({ db, logger: mockLogger, handlers });

    expect(updateFor('task-1')).toMatchObject({
      status: TaskScheduleStatus.FAILED,
      statusFailedAt: now,
      expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    expect(updateFor('task-1')!.statusFailedReason).toContain('Unknown schedule task handler');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error processing task schedule'),
      expect.any(Error)
    );
  });

  it('calls the handler with the correct payload', async () => {
    const task = makeTask();
    const { db } = setup([task]);
    mockHandler.mockResolvedValue(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(mockHandler).toHaveBeenCalledWith(task.payload);
  });

  it('logs info and error appropriately', async () => {
    const { db } = setup([makeTask()]);
    handlers[TaskScheduleHandler.RESEARCH_TASK_PROCESS] = vi.fn(() => {
      throw new Error('fail');
    });

    await process({ db, logger: mockLogger, handlers });

    expect(mockLogger.info).toHaveBeenCalledWith('Processed 1 task schedules');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error processing task schedule'),
      expect.any(Error)
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Finished processing task schedules');
  });

  it('processes multiple tasks', async () => {
    const { db, taskSchedules } = setup([makeTask(), makeTask({ id: 'task-2' })]);
    mockHandler.mockResolvedValue(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(taskSchedules.update).toHaveBeenCalledTimes(2);
    expect(mockHandler).toHaveBeenCalledTimes(2);
  });

  it('dispatches a due schedule exactly once across concurrent runs', async () => {
    const { db, rows, taskSchedules } = setup([makeTask()]);
    mockHandler.mockResolvedValue(undefined);

    await Promise.all([process({ db, logger: mockLogger, handlers }), process({ db, logger: mockLogger, handlers })]);

    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(taskSchedules.update).toHaveBeenCalledTimes(1);
    expect(rows[0]!.status).toBe(TaskScheduleStatus.COMPLETED);
  });

  it('keeps processing other due schedules while one handler never settles', async () => {
    const { db, rows, updateFor } = setup([
      makeTask({ payload: { id: 'stuck', userId: 'bar' } }),
      makeTask({ id: 'task-2', payload: { id: 'runnable', userId: 'bar' } }),
    ]);
    mockHandler.mockImplementation((payload: any) =>
      payload.id === 'stuck' ? new Promise<void>(() => {}) : Promise.resolve()
    );

    void process({ db, logger: mockLogger, handlers });

    await vi.waitFor(() => expect(updateFor('task-2')).toBeDefined());
    expect(updateFor('task-2')).toMatchObject({ status: TaskScheduleStatus.COMPLETED });
    expect(updateFor('task-1')).toBeUndefined();
    expect(rows[0]!.status).toBe(TaskScheduleStatus.PROCESSING);
  });

  it('reclaims a schedule whose lease has expired', async () => {
    const { db, updateFor } = setup([
      makeTask({
        status: TaskScheduleStatus.PROCESSING,
        claimedAt: new Date(now.getTime() - LEASE_TTL_MS - 1000),
      }),
    ]);
    mockHandler.mockResolvedValue(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(mockHandler).toHaveBeenCalledOnce();
    expect(updateFor('task-1')).toMatchObject({ status: TaskScheduleStatus.COMPLETED });
  });

  it('leaves a schedule whose lease is still live to its current owner', async () => {
    const { db, taskSchedules } = setup([
      makeTask({ status: TaskScheduleStatus.PROCESSING, claimedAt: new Date(now.getTime() - 60_000) }),
    ]);

    await process({ db, logger: mockLogger, handlers });

    expect(mockHandler).not.toHaveBeenCalled();
    expect(taskSchedules.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Processed 0 task schedules');
  });

  it('reclaims a PROCESSING schedule that carries no claim stamp', async () => {
    const { db, updateFor } = setup([makeTask({ status: TaskScheduleStatus.PROCESSING })]);
    mockHandler.mockResolvedValue(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(mockHandler).toHaveBeenCalledOnce();
    expect(updateFor('task-1')).toMatchObject({ status: TaskScheduleStatus.COMPLETED });
  });

  it('surfaces a persistence failure after every drain has settled', async () => {
    const { db, taskSchedules } = setup([makeTask()]);
    mockHandler.mockResolvedValue(undefined);
    taskSchedules.update.mockRejectedValueOnce(new Error('mongo down'));

    await expect(process({ db, logger: mockLogger, handlers })).rejects.toThrow('mongo down');
  });
});
