import { describe, it, expect, vi, beforeEach } from 'vitest';
import { process } from './process';
import { TaskScheduleStatus, TaskScheduleHandler } from '@bike4mind/common';

const mockHandler = vi.fn();
const mockLogger = { info: vi.fn(), error: vi.fn() };

const now = new Date('2024-01-01T00:00:00Z');
vi.setSystemTime(now);

const makeTask = (status = TaskScheduleStatus.PENDING) => ({
  id: 'task-1',
  handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
  payload: { id: 'foo', userId: 'bar' },
  status,
  createdAt: now,
  updatedAt: now,
  processDate: new Date(now.getTime() - 1000),
});

describe('taskSchedulerService/process', () => {
  let db: any;
  let handlers: any;

  beforeEach(() => {
    db = {
      taskSchedules: {
        findAllStatusPendingByProcessDateLessThan: vi.fn(),
        update: vi.fn(),
      },
    };
    handlers = {
      [TaskScheduleHandler.RESEARCH_TASK_PROCESS]: mockHandler,
    };
    vi.clearAllMocks();
  });

  it('sets expireAt when task is COMPLETED', async () => {
    const task = makeTask();
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([task]);
    db.taskSchedules.update.mockResolvedValue(undefined);
    mockHandler.mockResolvedValue(undefined);

    await process({ db, logger: mockLogger, handlers });

    expect(db.taskSchedules.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TaskScheduleStatus.COMPLETED,
        statusCompletedAt: expect.any(Date),
        expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
    );
  });

  it('sets expireAt when task is FAILED', async () => {
    const task = makeTask();
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([task]);
    db.taskSchedules.update.mockResolvedValue(undefined);
    // Handler will throw
    handlers[TaskScheduleHandler.RESEARCH_TASK_PROCESS] = vi.fn(() => {
      throw new Error('fail');
    });

    await process({ db, logger: mockLogger, handlers });

    expect(db.taskSchedules.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TaskScheduleStatus.FAILED,
        statusFailedAt: expect.any(Date),
        expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
    );
  });

  it('does nothing if there are no pending tasks', async () => {
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([]);
    await process({ db, logger: mockLogger, handlers });
    expect(db.taskSchedules.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('Found 0 task schedules to process');
    expect(mockLogger.info).toHaveBeenCalledWith('Finished processing task schedules');
  });

  it('sets task to FAILED if handler is not found', async () => {
    const task = makeTask();
    (task as any).handler = 'UNKNOWN_HANDLER';
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([task]);
    db.taskSchedules.update.mockResolvedValue(undefined);
    await process({ db, logger: mockLogger, handlers });
    expect(db.taskSchedules.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TaskScheduleStatus.FAILED,
        statusFailedAt: expect.any(Date),
        statusFailedReason: expect.stringContaining('Unknown schedule task handler'),
        expireAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      })
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error processing task schedule'),
      expect.any(Error)
    );
  });

  it('calls the handler with the correct payload', async () => {
    const task = makeTask();
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([task]);
    db.taskSchedules.update.mockResolvedValue(undefined);
    mockHandler.mockResolvedValue(undefined);
    await process({ db, logger: mockLogger, handlers });
    expect(mockHandler).toHaveBeenCalledWith(task.payload);
  });

  it('logs info and error appropriately', async () => {
    const task = makeTask();
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([task]);
    db.taskSchedules.update.mockResolvedValue(undefined);
    // Handler will throw
    handlers[TaskScheduleHandler.RESEARCH_TASK_PROCESS] = vi.fn(() => {
      throw new Error('fail');
    });
    await process({ db, logger: mockLogger, handlers });
    expect(mockLogger.info).toHaveBeenCalledWith('Found 1 task schedules to process');
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error processing task schedule'),
      expect.any(Error)
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Finished processing task schedules');
  });

  it('processes multiple tasks', async () => {
    const task1 = makeTask();
    const task2 = makeTask();
    task2.id = 'task-2';
    db.taskSchedules.findAllStatusPendingByProcessDateLessThan.mockResolvedValue([task1, task2]);
    db.taskSchedules.update.mockResolvedValue(undefined);
    mockHandler.mockResolvedValue(undefined);
    await process({ db, logger: mockLogger, handlers });
    expect(db.taskSchedules.update).toHaveBeenCalledTimes(2);
    expect(mockHandler).toHaveBeenCalledTimes(2);
  });
});
