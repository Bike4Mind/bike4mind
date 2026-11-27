import mongoose, { Model, model, Schema } from 'mongoose';
import {
  IEmailSendAttemptDocument,
  IEmailSendAttemptRepository,
  EmailDeliveryOutcome,
  EmailSendStatus,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { PaginatedResponse } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

export interface IEmailSendAttemptModel extends Model<IEmailSendAttemptDocument> {}

const EmailSendAttemptSchema = new Schema<IEmailSendAttemptDocument, IEmailSendAttemptModel>(
  {
    jobId: { type: String, required: true, index: true },
    recipientId: { type: String, required: true },
    recipientType: {
      type: String,
      enum: ['user', 'subscriber', 'direct'],
      required: true,
    },
    recipientEmail: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(EmailSendStatus),
      default: EmailSendStatus.PENDING,
    },
    trackingToken: { type: String, required: true, unique: true },
    sentAt: { type: Date },
    openedAt: { type: Date },
    clickedAt: { type: Date },
    clickedLinks: [{ type: String }],
    // Test mode fields
    isTestEmail: { type: Boolean, default: false },
    originalRecipient: { type: String },
    testSubjectIndicator: { type: Boolean },
    // Send metadata
    sentBy: { type: String },
    renderedSubject: { type: String },
    renderedHtml: { type: String },
    // Error handling
    errorMessage: { type: String },
    retryCount: { type: Number, default: 0 },
    // Batch send lease and sent marker: see claimForSend / markSendAccepted
    claimedAt: { type: Date },
    sendAccepted: {
      at: { type: Date },
      queued: { type: Boolean },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Indexes (trackingToken unique index is defined inline in the schema)
EmailSendAttemptSchema.index({ jobId: 1, status: 1 });
EmailSendAttemptSchema.index({ jobId: 1, isTestEmail: 1 });
EmailSendAttemptSchema.index({ recipientEmail: 1 });
EmailSendAttemptSchema.index({ createdAt: -1 });
EmailSendAttemptSchema.index({ jobId: 1, createdAt: -1 });

export class EmailSendAttemptRepository
  extends BaseRepository<IEmailSendAttemptDocument>
  implements IEmailSendAttemptRepository
{
  constructor(model: IEmailSendAttemptModel) {
    super(model);
  }

  async findByTrackingToken(token: string): Promise<IEmailSendAttemptDocument | null> {
    const result = await this.model.findOne({ trackingToken: token });
    return result?.toJSON() ?? null;
  }

  async findByJob(
    jobId: string,
    options: {
      page: number;
      limit: number;
      status?: EmailSendStatus;
      search?: string;
      excludeTest?: boolean;
      startDate?: Date;
      endDate?: Date;
    }
  ): Promise<PaginatedResponse<IEmailSendAttemptDocument>> {
    const { page, limit, status, search, excludeTest, startDate, endDate } = options;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { jobId };

    if (status) {
      query.status = status;
    }

    if (excludeTest) {
      query.isTestEmail = { $ne: true };
    }

    if (search) {
      const escapedSearch = escapeRegex(search);
      query.$or = [
        { recipientEmail: { $regex: escapedSearch, $options: 'i' } },
        { renderedSubject: { $regex: escapedSearch, $options: 'i' } },
      ];
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) {
        (query.createdAt as Record<string, unknown>).$gte = startDate;
      }
      if (endDate) {
        // extend to end of day so the full endDate is included
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        // setHours overflows to an Invalid Date when endDate already sits at the top of the
        // representable range, and an Invalid Date casts against the Date-typed `createdAt`
        // and throws. Fall back to the un-extended date: the only day this loses the
        // end-of-day extension on is the last representable one, which no stored document
        // can exceed anyway. Validating the caller's string belongs at the HTTP boundary,
        // not here -- this repository cannot tell a wire value from a computed one.
        (query.createdAt as Record<string, unknown>).$lte = Number.isNaN(endOfDay.getTime()) ? endDate : endOfDay;
      }
    }

    const [attempts, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      this.model.countDocuments(query),
    ]);

    return {
      data: attempts.map(doc => doc.toJSON()),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    };
  }

  /**
   * PENDING/PROCESSING -> QUEUED once the event bus accepts the mail. Also from CANCELLED: a cancel
   * that lands mid-publish cannot stop mail the bus accepted. Returns false when the email-send worker
   * already wrote its outcome, which can land before this write.
   */
  async markQueued(id: string, updates: { sentAt: Date; retryCount: number }): Promise<boolean> {
    const result = await this.model.updateOne(
      {
        _id: id,
        status: { $in: [EmailSendStatus.PENDING, EmailSendStatus.PROCESSING, EmailSendStatus.CANCELLED] },
      },
      { $set: { status: EmailSendStatus.QUEUED, ...updates } },
      { runValidators: true }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Writes the transport's result, never downgrading an attempt already SENT or past it
   * (delivered, opened, clicked, bounced, complained). FAILED -> SENT is allowed: a retried send can
   * succeed. CANCELLED is overwritten too: an outcome exists only for a published mail, and a failure
   * left CANCELLED would let a later markQueued turn it into QUEUED. Returns the jobId when the write
   * applied, else null.
   */
  async recordDeliveryOutcome(
    id: string,
    outcome: EmailDeliveryOutcome,
    options?: { retryCount?: number }
  ): Promise<string | null> {
    const retryCount = options?.retryCount;
    const update = outcome.ok
      ? {
          $set: { status: EmailSendStatus.SENT, sentAt: outcome.at, ...(retryCount !== undefined && { retryCount }) },
          $unset: { errorMessage: 1 },
        }
      : { $set: { status: EmailSendStatus.FAILED, errorMessage: outcome.error }, $inc: { retryCount: 1 } };
    const result = await this.model.findOneAndUpdate(
      {
        _id: id,
        status: {
          $in: [
            EmailSendStatus.PENDING,
            EmailSendStatus.PROCESSING,
            EmailSendStatus.QUEUED,
            EmailSendStatus.FAILED,
            EmailSendStatus.CANCELLED,
          ],
        },
      },
      update,
      { new: true, projection: { jobId: 1 }, runValidators: true }
    );
    return result?.jobId ?? null;
  }

  /**
   * Records the batch's own give-up. Matches only an attempt still PENDING/PROCESSING: a publish that
   * threw may still have been accepted, and the worker's outcome must win over this write.
   */
  async markSendFailed(id: string, updates: { errorMessage: string; retryCount: number }): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, status: { $in: [EmailSendStatus.PENDING, EmailSendStatus.PROCESSING] } },
      { $set: { status: EmailSendStatus.FAILED, ...updates } },
      { runValidators: true }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Claims an attempt for sending: PENDING, or PROCESSING whose lease (claimedAt) predates staleBefore
   * and whose mail was never accepted. A PROCESSING attempt written before leases existed has no
   * claimedAt and is judged by updatedAt. Returns false when another invocation holds a fresh lease
   * or the attempt already moved on.
   */
  async claimForSend(
    id: string,
    options: { now: Date; staleBefore: Date; renderedSubject: string; renderedHtml: string }
  ): Promise<boolean> {
    const { now, staleBefore, renderedSubject, renderedHtml } = options;
    const result = await this.model.updateOne(
      {
        _id: id,
        'sendAccepted.at': { $exists: false },
        $or: [
          { status: EmailSendStatus.PENDING },
          { status: EmailSendStatus.PROCESSING, claimedAt: { $lt: staleBefore } },
          { status: EmailSendStatus.PROCESSING, claimedAt: { $exists: false }, updatedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: EmailSendStatus.PROCESSING, claimedAt: now, renderedSubject, renderedHtml } },
      { runValidators: true }
    );
    return result.modifiedCount > 0;
  }

  /**
   * Records that the mailer accepted the mail while the attempt is still PROCESSING, so a later batch
   * finishes the status write instead of sending again.
   */
  async markSendAccepted(id: string, accepted: { at: Date; queued: boolean }): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: id, status: EmailSendStatus.PROCESSING },
      { $set: { sendAccepted: accepted } },
      { runValidators: true }
    );
    return result.modifiedCount > 0;
  }

  async markOpened(trackingToken: string): Promise<IEmailSendAttemptDocument | null> {
    const result = await this.model.findOneAndUpdate(
      {
        trackingToken,
        openedAt: { $exists: false }, // Only mark opened if not already opened
      },
      {
        $set: {
          openedAt: new Date(),
          status: EmailSendStatus.OPENED,
        },
      },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  async recordClick(trackingToken: string, link: string): Promise<IEmailSendAttemptDocument | null> {
    const result = await this.model.findOneAndUpdate(
      { trackingToken },
      {
        $set: {
          clickedAt: new Date(),
          status: EmailSendStatus.CLICKED,
        },
        $addToSet: { clickedLinks: link },
      },
      { new: true }
    );
    return result?.toJSON() ?? null;
  }

  /**
   * Get aggregated summary of send attempts for a job
   * Uses aggregation pipeline for efficiency with large datasets
   */
  async getJobSummary(jobId: string): Promise<{
    total: number;
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
    testEmails: {
      total: number;
      pending: number;
      processing: number;
      sent: number;
      failed: number;
      cancelled: number;
    };
  }> {
    const pipeline = [
      { $match: { jobId } },
      {
        $facet: {
          overall: [
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 },
              },
            },
          ],
          testEmails: [
            { $match: { isTestEmail: true } },
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 },
              },
            },
          ],
        },
      },
    ];

    const [result] = await this.model.aggregate(pipeline);

    const statusCounts = {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    };

    const testStatusCounts = {
      pending: 0,
      processing: 0,
      sent: 0,
      failed: 0,
      cancelled: 0,
    };

    // Map status counts
    for (const item of result?.overall || []) {
      const status = item._id as string;
      if (status === EmailSendStatus.PENDING) statusCounts.pending = item.count;
      else if (status === EmailSendStatus.PROCESSING) statusCounts.processing = item.count;
      else if (status === EmailSendStatus.SENT || status === EmailSendStatus.DELIVERED) statusCounts.sent += item.count;
      else if (status === EmailSendStatus.QUEUED) statusCounts.sent += item.count;
      else if (status === EmailSendStatus.OPENED || status === EmailSendStatus.CLICKED) statusCounts.sent += item.count;
      else if (status === EmailSendStatus.FAILED || status === EmailSendStatus.BOUNCED)
        statusCounts.failed += item.count;
      else if (status === EmailSendStatus.CANCELLED) statusCounts.cancelled = item.count;
    }

    // Map test email status counts
    for (const item of result?.testEmails || []) {
      const status = item._id as string;
      if (status === EmailSendStatus.PENDING) testStatusCounts.pending = item.count;
      else if (status === EmailSendStatus.PROCESSING) testStatusCounts.processing = item.count;
      else if (status === EmailSendStatus.SENT || status === EmailSendStatus.DELIVERED)
        testStatusCounts.sent += item.count;
      else if (status === EmailSendStatus.QUEUED) testStatusCounts.sent += item.count;
      else if (status === EmailSendStatus.OPENED || status === EmailSendStatus.CLICKED)
        testStatusCounts.sent += item.count;
      else if (status === EmailSendStatus.FAILED || status === EmailSendStatus.BOUNCED)
        testStatusCounts.failed += item.count;
      else if (status === EmailSendStatus.CANCELLED) testStatusCounts.cancelled = item.count;
    }

    const total =
      statusCounts.pending + statusCounts.processing + statusCounts.sent + statusCounts.failed + statusCounts.cancelled;
    const testTotal =
      testStatusCounts.pending +
      testStatusCounts.processing +
      testStatusCounts.sent +
      testStatusCounts.failed +
      testStatusCounts.cancelled;

    return {
      total,
      ...statusCounts,
      testEmails: {
        total: testTotal,
        ...testStatusCounts,
      },
    };
  }

  /**
   * Cancel pending/processing attempts for a job
   * @param jobId - The job ID
   * @param recipientIds - Optional list of recipient IDs to cancel (if not provided, cancels all)
   * @returns Number of attempts cancelled
   */
  async cancelPendingAttempts(jobId: string, recipientIds?: string[]): Promise<number> {
    const query: Record<string, unknown> = {
      jobId,
      status: { $in: [EmailSendStatus.PENDING, EmailSendStatus.PROCESSING] },
    };

    if (recipientIds && recipientIds.length > 0) {
      query.recipientId = { $in: recipientIds };
    }

    const result = await this.model.updateMany(query, {
      $set: { status: EmailSendStatus.CANCELLED },
    });

    return result.modifiedCount;
  }

  /**
   * Get send status for specific recipients in a job
   * @param jobId - The job ID
   * @param recipientIds - List of recipient IDs to check
   * @returns Map of recipientId to send count and last sent date
   */
  async getRecipientSendStatus(
    jobId: string,
    recipientIds: string[]
  ): Promise<Map<string, { sendCount: number; lastSentAt?: Date }>> {
    if (recipientIds.length === 0) {
      return new Map();
    }

    const sendAttempts = await this.model.aggregate([
      {
        $match: {
          jobId,
          recipientId: { $in: recipientIds },
        },
      },
      {
        $group: {
          _id: '$recipientId',
          sendCount: { $sum: 1 },
          lastSentAt: { $max: '$sentAt' },
        },
      },
    ]);

    const result = new Map<string, { sendCount: number; lastSentAt?: Date }>();
    for (const attempt of sendAttempts) {
      result.set(attempt._id, {
        sendCount: attempt.sendCount,
        lastSentAt: attempt.lastSentAt,
      });
    }

    return result;
  }
}

export const EmailSendAttempt =
  (mongoose.models.EmailSendAttempt as unknown as IEmailSendAttemptModel) ??
  model<IEmailSendAttemptDocument, IEmailSendAttemptModel>('EmailSendAttempt', EmailSendAttemptSchema);

export const emailSendAttemptRepository = new EmailSendAttemptRepository(EmailSendAttempt);

export default EmailSendAttempt;
