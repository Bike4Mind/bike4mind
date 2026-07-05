import mongoose, { Model, model, Schema } from 'mongoose';
import {
  IEmailJobDocument,
  IEmailJobRepository,
  EmailJobStatus,
  EmailJobOverallStatus,
  EmailCategory,
  IEmailJob,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { PaginatedResponse } from '@bike4mind/common';

export interface IEmailJobModel extends Model<IEmailJobDocument> {}

const EmailRecipientFilterSchema = new Schema(
  {
    all: { type: Boolean },
    allUsers: { type: Boolean },
    allSubscribers: { type: Boolean },
    userIds: [{ type: String }],
    subscriberIds: [{ type: String }],
    specificEmails: [{ type: String }],
    tags: [{ type: String }],
  },
  { _id: false }
);

const EmailJobSchema = new Schema<IEmailJobDocument, IEmailJobModel>(
  {
    name: { type: String, required: true },
    templateId: { type: String, required: true },
    subject: { type: String },
    variables: { type: Map, of: String, default: {} },
    category: {
      type: String,
      enum: Object.values(EmailCategory),
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(EmailJobStatus),
      default: EmailJobStatus.DRAFT,
    },
    // Reusable campaign status - tracks send history
    overallStatus: {
      type: String,
      enum: Object.values(EmailJobOverallStatus),
      default: EmailJobOverallStatus.DRAFT,
    },
    recipientFilter: { type: EmailRecipientFilterSchema },
    recipientCount: { type: Number, default: 0 },
    isTestMode: { type: Boolean, default: false },
    testEmailAddresses: [{ type: String }],
    scheduledAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
    // Cumulative counters across all sends
    totalEmailsSent: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    cancelledCount: { type: Number, default: 0 },
    openedCount: { type: Number, default: 0 },
    clickedCount: { type: Number, default: 0 },
    // Last send info
    lastSentAt: { type: Date },
    lastSentBy: { type: String },
    // Audit
    createdBy: { type: String, required: true },
    startedBy: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        // Convert Map to plain object for JSON serialization
        if (ret.variables instanceof Map) {
          ret.variables = Object.fromEntries(ret.variables);
        }
        return ret;
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Indexes
EmailJobSchema.index({ status: 1 });
EmailJobSchema.index({ createdAt: -1 });
EmailJobSchema.index({ templateId: 1 });
EmailJobSchema.index({ createdBy: 1 });
EmailJobSchema.index({ scheduledAt: 1 }, { sparse: true });

export class EmailJobRepository extends BaseRepository<IEmailJobDocument> implements IEmailJobRepository {
  constructor(model: IEmailJobModel) {
    super(model);
  }

  async findByStatus(status: EmailJobStatus): Promise<IEmailJobDocument[]> {
    const results = await this.model.find({ status }).sort({ createdAt: -1 });
    return results.map(doc => doc.toJSON());
  }

  async listJobs(options: {
    page: number;
    limit: number;
    status?: EmailJobStatus;
    excludeTest?: boolean;
    startDate?: Date;
    endDate?: Date;
  }): Promise<PaginatedResponse<IEmailJobDocument>> {
    const { page, limit, status, excludeTest, startDate, endDate } = options;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (status) {
      query.status = status;
    }

    if (excludeTest) {
      query.isTestMode = { $ne: true };
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        (query.createdAt as Record<string, unknown>).$gte = startDate;
      }
      if (endDate) {
        (query.createdAt as Record<string, unknown>).$lte = endDate;
      }
    }

    const [jobs, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      this.model.countDocuments(query),
    ]);

    return {
      data: jobs.map(doc => doc.toJSON()),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    };
  }

  async incrementCounts(
    id: string,
    field: 'sentCount' | 'failedCount' | 'cancelledCount' | 'openedCount' | 'clickedCount' | 'totalEmailsSent'
  ): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $inc: { [field]: 1 } });
  }

  /**
   * Increment a count field by a specific amount (for batch updates)
   */
  async incrementCountsBy(
    id: string,
    field: 'sentCount' | 'failedCount' | 'cancelledCount' | 'openedCount' | 'clickedCount' | 'totalEmailsSent',
    amount: number
  ): Promise<void> {
    await this.model.findByIdAndUpdate(id, { $inc: { [field]: amount } });
  }

  async updateOverallStatus(
    id: string,
    overallStatus: EmailJobOverallStatus,
    updates?: Partial<IEmailJob>
  ): Promise<void> {
    await this.model.findByIdAndUpdate(id, { overallStatus, ...updates });
  }

  /**
   * Atomically set overallStatus to SENDING only if not already SENDING.
   * Returns the updated doc, or null if the job was already sending (prevents duplicate sends).
   */
  async claimForSending(id: string, updates?: Partial<IEmailJob>): Promise<IEmailJobDocument | null> {
    return this.model.findOneAndUpdate(
      { _id: id, overallStatus: { $ne: EmailJobOverallStatus.SENDING } },
      { $set: { overallStatus: EmailJobOverallStatus.SENDING, ...updates } },
      { new: true }
    );
  }

  /**
   * Find scheduled jobs that are due to be sent
   * Returns jobs with status SCHEDULED where scheduledAt <= now
   */
  async findDueScheduledJobs(): Promise<IEmailJobDocument[]> {
    const results = await this.model.find({
      status: EmailJobStatus.SCHEDULED,
      scheduledAt: { $lte: new Date() },
    });
    return results.map(doc => doc.toJSON());
  }
}

export const EmailJob =
  (mongoose.models.EmailJob as unknown as IEmailJobModel) ??
  model<IEmailJobDocument, IEmailJobModel>('EmailJob', EmailJobSchema);

export const emailJobRepository = new EmailJobRepository(EmailJob);

export default EmailJob;
