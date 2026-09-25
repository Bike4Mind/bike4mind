import {
  ITaskSchedulePayloadMap,
  ITaskScheduleRepository,
  TaskScheduleHandler,
  TaskScheduleStatus,
} from '@bike4mind/common';

/**
 * Comfortably above the hosted cron's 10 minute function timeout, so a handler that is still
 * running can never have its row reclaimed and dispatched a second time. The cost of the margin is
 * that a process killed mid-handler leaves its row unavailable for this long before a later tick
 * retries it.
 */
const LEASE_TTL_MS = 30 * 60 * 1000;

/**
 * How many schedules may be in flight at once. Bounded so one handler that never settles stalls
 * only its own slot instead of every schedule behind it in the tick.
 */
const CLAIM_CONCURRENCY = 5;

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
 * Processes all task schedules that are due. Each schedule is claimed atomically before its handler
 * runs, so overlapping invocations (the hosted cron fires every 5 minutes against a 10 minute
 * timeout) never dispatch the same schedule twice.
 */
export const process = async ({ db, logger, handlers }: SchedulerProcessAdapters) => {
  const TTL_DAYS = 7; // TODO: Make configurable
  // Fixed cutoff rather than a fresh `new Date()` per claim: a schedule that falls due mid-run
  // belongs to the next tick, and it is what bounds this loop.
  const dueBefore = new Date();
  const leaseExpiredBefore = new Date(dueBefore.getTime() - LEASE_TTL_MS);
  let claimedCount = 0;

  const drain = async () => {
    for (;;) {
      const taskSchedule = await db.taskSchedules.claimDueTaskSchedule(dueBefore, leaseExpiredBefore);

      if (!taskSchedule) {
        return;
      }
      claimedCount += 1;

      try {
        const handler = handlers[taskSchedule.handler];

        if (!handler) {
          throw new Error(`Unknown schedule task handler: ${taskSchedule.handler}`);
        }

        // Cast through a generic payload signature: the handler-union parameter types don't
        // narrow against taskSchedule.payload, so a direct call would be a type error.
        await (handler as (payload: unknown) => Promise<void>)(taskSchedule.payload);

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
  };

  // allSettled rather than all: a rejected drain must not leave its siblings running unawaited past
  // the end of the invocation, where a Lambda freeze would strand their claims. The failure still
  // surfaces once every drain has settled.
  const outcomes = await Promise.allSettled(Array.from({ length: CLAIM_CONCURRENCY }, () => drain()));

  logger?.info(`Processed ${claimedCount} task schedules`);

  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (rejected) {
    throw rejected.reason;
  }

  logger?.info('Finished processing task schedules');
};
