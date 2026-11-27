import mongoose from 'mongoose';

export type DlqFailureCategory = 'refused' | 'timeout' | 'invalid output' | 'bug' | 'unknown';

export interface IDlqFailure {
  queueLabel: string;
  messageId: string;
  errorType: string;
  errorMessage: string;
  category: DlqFailureCategory;
  terminalRefusal?: boolean;
  transientFailure?: boolean;
  failedAt: Date;
  consumerVersion: string;
}

const DlqFailureSchema = new mongoose.Schema<IDlqFailure>({
  queueLabel: { type: String, required: true },
  messageId: { type: String, required: true },
  errorType: { type: String, required: true },
  errorMessage: { type: String, required: true },
  category: { type: String, enum: ['refused', 'timeout', 'invalid output', 'bug', 'unknown'], required: true },
  terminalRefusal: { type: Boolean },
  transientFailure: { type: Boolean },
  failedAt: { type: Date, required: true },
  consumerVersion: { type: String, required: true },
});

DlqFailureSchema.index({ queueLabel: 1, messageId: 1 }, { unique: true });
// SQS caps a DLQ's message retention at 14 days; keep the reason through its last day.
DlqFailureSchema.index({ failedAt: 1 }, { expireAfterSeconds: 15 * 24 * 60 * 60 });

const DlqFailureModel =
  (mongoose.models['DlqFailure'] as mongoose.Model<IDlqFailure> | undefined) ||
  mongoose.model<IDlqFailure>('DlqFailure', DlqFailureSchema);

export const dlqFailureRepository = {
  async record(failure: IDlqFailure): Promise<void> {
    await DlqFailureModel.updateOne(
      { queueLabel: failure.queueLabel, messageId: failure.messageId },
      { $setOnInsert: failure },
      { upsert: true }
    );
  },

  async findForMessages(queueLabel: string, messageIds: string[]): Promise<IDlqFailure[]> {
    return DlqFailureModel.find({ queueLabel, messageId: { $in: messageIds } })
      .lean()
      .exec();
  },
};

export default DlqFailureModel;
