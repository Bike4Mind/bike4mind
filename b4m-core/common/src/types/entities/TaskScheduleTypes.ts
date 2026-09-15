import { IBaseRepository } from './BaseTypes';

export enum TaskScheduleStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export enum TaskScheduleHandler {
  RESEARCH_TASK_PROCESS = 'researchTask.process',
  CUSTOM_TASK_PROCESS = 'customTask.process', // Not used - example only
}

export interface IBaseTaskSchedule {
  /**
   * The unique identifier for the schedule task
   */
  id: string;
  /**
   * The name of the handler that will process the schedule task
   */
  handler: TaskScheduleHandler;

  /**
   * The payload of the schedule task in JSON format
   */
  payload: Record<string, unknown>;
  /**
   * The status of the schedule task
   */
  status: TaskScheduleStatus;
  /**
   * The reason the schedule task failed
   */
  statusFailedReason?: string;
  /**
   * The date and time the schedule task failed
   */
  statusFailedAt?: Date;
  /**
   * The date and time the schedule task was completed
   */
  statusCompletedAt?: Date;
  /**
   * The date and time the schedule task was processed
   */
  processDate?: Date;
  /**
   * The date and time the schedule task was created
   */
  createdAt: Date;

  /**
   * The date and time the schedule task was last updated
   */
  updatedAt: Date;
  /**
   * The date and time the schedule task will expire (for TTL)
   */
  expireAt?: Date;
}

export type ITaskScheduleResearchTask = IBaseTaskSchedule & {
  handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS;
  payload: {
    /**
     * The ID of the research task
     */
    id: string;
    /**
     * The ID of the user
     */
    userId: string;
  };
};

export type ITaskScheduleCustomTask = IBaseTaskSchedule & {
  handler: TaskScheduleHandler.CUSTOM_TASK_PROCESS;
  payload: {
    test: string;
  };
};

// Type that maps each handler to its respective payload type
export type ITaskSchedulePayloadMap = {
  [TaskScheduleHandler.RESEARCH_TASK_PROCESS]: ITaskScheduleResearchTask['payload'];
  [TaskScheduleHandler.CUSTOM_TASK_PROCESS]: ITaskScheduleCustomTask['payload'];
};

export type ITaskSchedule = ITaskScheduleResearchTask | ITaskScheduleCustomTask;
export interface ITaskScheduleRepository extends IBaseRepository<ITaskSchedule> {
  findAllStatusPendingByProcessDateLessThan: (processDate: Date) => Promise<ITaskSchedule[]>;
}
