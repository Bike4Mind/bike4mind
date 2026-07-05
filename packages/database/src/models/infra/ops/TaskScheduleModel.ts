import mongoose from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { ITaskSchedule, ITaskScheduleRepository, TaskScheduleHandler, TaskScheduleStatus } from '@bike4mind/common';

const TaskScheduleSchema = new mongoose.Schema(
  {
    handler: { type: String, enum: TaskScheduleHandler, required: true },
    payload: { type: Object, required: true },
    status: { type: String, enum: TaskScheduleStatus, required: true },
    statusFailedReason: { type: String, required: false },
    statusFailedAt: { type: Date, required: false },
    statusCompletedAt: { type: Date, required: false },
    processDate: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    expireAt: { type: Date, required: false, index: { expireAfterSeconds: 0 } },
  },
  {
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

const TaskScheduleModel =
  (mongoose.models['TaskSchedule'] as unknown as mongoose.Model<ITaskSchedule>) ||
  mongoose.model<ITaskSchedule>('TaskSchedule', TaskScheduleSchema);

class TaskScheduleRepository extends BaseRepository<ITaskSchedule> implements ITaskScheduleRepository {
  constructor(private taskScheduleModel: mongoose.Model<ITaskSchedule>) {
    super(taskScheduleModel);
  }

  async findAllStatusPendingByProcessDateLessThan(processDate: Date): Promise<ITaskSchedule[]> {
    const result = await this.model.find({ status: TaskScheduleStatus.PENDING, processDate: { $lt: processDate } });
    return result.map(doc => doc.toJSON());
  }
}

export const taskScheduleRepository = new TaskScheduleRepository(TaskScheduleModel);

export default TaskScheduleRepository;
