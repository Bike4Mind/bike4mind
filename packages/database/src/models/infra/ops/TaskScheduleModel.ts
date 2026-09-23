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
    claimedAt: { type: Date, required: false },
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

TaskScheduleSchema.index({ status: 1, processDate: 1 });

const TaskScheduleModel =
  (mongoose.models['TaskSchedule'] as unknown as mongoose.Model<ITaskSchedule>) ||
  mongoose.model<ITaskSchedule>('TaskSchedule', TaskScheduleSchema);

class TaskScheduleRepository extends BaseRepository<ITaskSchedule> implements ITaskScheduleRepository {
  constructor(private taskScheduleModel: mongoose.Model<ITaskSchedule>) {
    super(taskScheduleModel);
  }

  async claimDueTaskSchedule(processDate: Date, leaseExpiredBefore: Date): Promise<ITaskSchedule | null> {
    const claimedAt = new Date();
    const claimed = await this.model.findOneAndUpdate(
      {
        processDate: { $lt: processDate },
        $or: [
          { status: TaskScheduleStatus.PENDING },
          { status: TaskScheduleStatus.PROCESSING, claimedAt: { $lt: leaseExpiredBefore } },
          // Matches an absent claimedAt too, so a PROCESSING row that lost its stamp stays
          // recoverable rather than stranded until the expireAt TTL removes it.
          { status: TaskScheduleStatus.PROCESSING, claimedAt: null },
        ],
      },
      { $set: { status: TaskScheduleStatus.PROCESSING, claimedAt, updatedAt: claimedAt } },
      { new: true, sort: { processDate: 1 } }
    );
    return claimed ? claimed.toJSON() : null;
  }
}

export const taskScheduleRepository = new TaskScheduleRepository(TaskScheduleModel);

export default TaskScheduleRepository;
