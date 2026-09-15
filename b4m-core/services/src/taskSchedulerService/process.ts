import {
  ITaskSchedulePayloadMap,
  ITaskScheduleRepository,
  TaskScheduleHandler,
  TaskScheduleStatus,
} from '@bike4mind/common';

interface SchedulerProcessAdapters {
  db: {
    taskSchedules: ITaskScheduleRepository;
  };
  logger?: {
    info: (message: string) => void;
    error: (message: string, error?: Error) => void;
  };
  /**
   * Handler are background functions that will be called by this process function
   */
  handlers: {
    [H in TaskScheduleHandler]: (payload: ITaskSchedulePayloadMap[H]) => Promise<void>;
  };
}

/**
 * This function processes all task schedules that are pending and have a process date that is less than the current date.
 */
export const process = async ({ db, logger, handlers }: SchedulerProcessAdapters) => {
  const TTL_DAYS = 7; // TODO: Make configurable
  const taskSchedules = await db.taskSchedules.findAllStatusPendingByProcessDateLessThan(new Date());

  logger?.info(`Found ${taskSchedules.length} task schedules to process`);

  for (const taskSchedule of taskSchedules) {
    try {
      const handler = handlers[taskSchedule.handler];

      if (!handler) {
        throw new Error(`Unknown schedule task handler: ${taskSchedule.handler}`);
      }

      // Cast through a generic payload signature: the handler-union parameter types don't
      // narrow against taskSchedule.payload, so a direct call would be a type error.
      (handler as (payload: unknown) => Promise<void>)(taskSchedule.payload);

      taskSchedule.status = TaskScheduleStatus.COMPLETED;
      taskSchedule.statusCompletedAt = new Date();
      taskSchedule.expireAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
    } catch (e) {
      logger?.error(`Error processing task schedule: ${taskSchedule.id}`, e as Error);

      taskSchedule.status = TaskScheduleStatus.FAILED;
      taskSchedule.statusFailedAt = new Date();
      taskSchedule.statusFailedReason = e instanceof Error ? e.message : 'Unknown error';
      taskSchedule.expireAt = new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
    }
    await db.taskSchedules.update(taskSchedule);
  }
  logger?.info('Finished processing task schedules');
};
