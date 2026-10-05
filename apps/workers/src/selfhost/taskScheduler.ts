import { taskSchedulerService } from '@bike4mind/services';
import { taskScheduleRepository } from '@bike4mind/database';
import { TaskScheduleHandler } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import type { SelfHostWorker } from './selfHostWorker';

/** Scheduler cadence (hosted cron runs on a schedule; self-host polls the schedule table). */
const SCHEDULER_INTERVAL_MS = 5 * 60_000;

export function registerTaskScheduler(worker: Pick<SelfHostWorker, 'registerScheduledTask'>, logger: Logger): void {
  // Mirrors cron/scheduler.ts (hosted). Keep the handler map in sync with it.
  worker.registerScheduledTask('scheduler', SCHEDULER_INTERVAL_MS, async () => {
    await taskSchedulerService.process({
      db: { taskSchedules: taskScheduleRepository },
      logger,
      handlers: {
        [TaskScheduleHandler.RESEARCH_TASK_PROCESS]: async payload => {
          await sendToQueue(Resource.researchEngineQueue.url, { action: 'process', payload });
        },
        [TaskScheduleHandler.CUSTOM_TASK_PROCESS]: async () => {},
      },
    });
  });
}
