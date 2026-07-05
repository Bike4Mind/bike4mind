import { secureParameters } from '@bike4mind/utils';
import { ITaskSchedule, ITaskScheduleRepository, TaskScheduleHandler, TaskScheduleStatus } from '@bike4mind/common';
import { z } from 'zod';

// Type-safe payload validation based on handler
const researchTaskPayload = z.object({
  id: z.string(),
  userId: z.string(),
});

const customTaskPayload = z.object({
  test: z.string(),
});

// Discriminated union for type-safety
const taskSchedulerCreate = z.discriminatedUnion('handler', [
  z.object({
    handler: z.literal(TaskScheduleHandler.RESEARCH_TASK_PROCESS),
    payload: researchTaskPayload,
    processDate: z.date(),
  }),
  z.object({
    handler: z.literal(TaskScheduleHandler.CUSTOM_TASK_PROCESS),
    payload: customTaskPayload,
    processDate: z.date(),
  }),
]);

type TaskSchedulerCreateParameters = z.infer<typeof taskSchedulerCreate>;

interface TaskSchedulerCreateAdapters {
  db: {
    taskSchedules: ITaskScheduleRepository;
  };
}

export const create = async (parameters: TaskSchedulerCreateParameters, { db }: TaskSchedulerCreateAdapters) => {
  const { handler, payload, processDate } = secureParameters(parameters, taskSchedulerCreate);

  const build: Omit<ITaskSchedule, 'id'> = {
    handler,
    payload,
    processDate,
    status: TaskScheduleStatus.PENDING,

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.taskSchedules.create(build);
};
