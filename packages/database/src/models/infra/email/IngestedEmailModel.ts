import mongoose from 'mongoose';
import { softDeletePlugin } from '../../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { IIngestedEmail, IIngestedEmailDocument, IIngestedEmailRepository } from '@bike4mind/common';

const EmailAttachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    fabFileId: { type: String, required: false },
    s3Path: { type: String, required: false },
  },
  { _id: false }
);

const ScrapedLinkSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    title: { type: String, required: false },
    scrapedAt: { type: Date, required: false },
    fabFileId: { type: String, required: false },
    failed: { type: Boolean, default: false },
    failureReason: { type: String, required: false },
  },
  { _id: false }
);

const ActionItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    deadline: { type: Date, required: false },
  },
  { _id: false }
);

const EmailAIAnalysisSchema = new mongoose.Schema(
  {
    summary: { type: String, required: false },
    entities: {
      companies: { type: [String], default: [] },
      people: { type: [String], default: [] },
      products: { type: [String], default: [] },
      technologies: { type: [String], default: [] },
    },
    suggestedTags: { type: [String], default: [] },
    sentiment: {
      type: String,
      enum: ['positive', 'neutral', 'negative', 'urgent'],
      required: false,
    },
    actionItems: { type: [ActionItemSchema], default: [] },
    privacyRecommendation: {
      type: String,
      enum: ['public', 'team', 'private'],
      required: false,
    },
    embargoDetected: { type: Boolean, default: false },
    analyzedAt: { type: Date, required: false },
    model: { type: String, required: false },
    tokensUsed: {
      input: { type: Number, required: false },
      output: { type: Number, required: false },
    },
    costUSD: { type: Number, required: false },
  },
  { _id: false }
);

const IngestedEmailSchema = new mongoose.Schema(
  {
    // Email Identifiers
    messageId: { type: String, required: true, unique: true },
    inReplyTo: { type: String, required: false },
    references: { type: [String], default: [] },
    threadId: { type: String, required: true, index: true },

    // Email Headers
    from: { type: String, required: true },
    to: { type: [String], required: true },
    cc: { type: [String], default: [] },
    bcc: { type: [String], default: [] },
    subject: { type: String, required: true },
    date: { type: Date, required: true },

    // Email Content
    bodyText: { type: String, required: false },
    bodyHtml: { type: String, required: false },
    bodyMarkdown: { type: String, required: false },
    bodyS3Path: { type: String, required: false },
    bodyFabFileId: { type: String, required: false }, // FabFile for substantial email bodies

    // Attachments & Links
    attachments: { type: [EmailAttachmentSchema], default: [] },
    scrapedLinks: { type: [ScrapedLinkSchema], default: [] },

    // AI Analysis
    aiAnalysis: { type: EmailAIAnalysisSchema, required: false },

    // Privacy & Sharing
    visibilityLevel: {
      type: String,
      enum: ['private', 'team', 'organization', 'custom'],
      default: 'private',
      required: true,
    },
    sharedWithTeams: { type: [String], default: [] },
    sharedWithUsers: { type: [String], default: [] },
    embargoUntil: { type: Date, required: false },

    // Metadata
    userId: { type: String, required: true, index: true },
    organizationId: { type: String, required: false, index: true },
    platformEmailAddress: { type: String, required: false, index: true },
    rawEmailS3Key: { type: String, required: false },

    // Flags
    isSpam: { type: Boolean, default: false },
    isNewsletter: { type: Boolean, default: false },
    requiresReview: { type: Boolean, default: false },

    // Timestamps
    receivedAt: { type: Date, required: true },
    ingestedAt: { type: Date, default: Date.now },
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

// Compound Indexes (single-field indexes are defined inline in schema above)
IngestedEmailSchema.index({ threadId: 1, userId: 1 });
IngestedEmailSchema.index({ userId: 1, receivedAt: -1 });
IngestedEmailSchema.index({ organizationId: 1, receivedAt: -1 });
IngestedEmailSchema.index({ 'aiAnalysis.suggestedTags': 1 });
IngestedEmailSchema.index({ embargoUntil: 1 }, { sparse: true });

IngestedEmailSchema.plugin(softDeletePlugin);

const IngestedEmailModel =
  (mongoose.models['IngestedEmail'] as unknown as mongoose.Model<IIngestedEmail>) ||
  mongoose.model<IIngestedEmail>('IngestedEmail', IngestedEmailSchema);

class IngestedEmailRepository extends BaseRepository<IIngestedEmailDocument> implements IIngestedEmailRepository {
  constructor(private ingestedEmailModel: mongoose.Model<IIngestedEmail>) {
    super(ingestedEmailModel);
  }

  async findByMessageId(messageId: string): Promise<IIngestedEmailDocument | null> {
    const result = await this.ingestedEmailModel.findOne({ messageId });
    return result?.toJSON() ?? null;
  }

  async findByThreadId(threadId: string, userId: string): Promise<IIngestedEmailDocument[]> {
    const results = await this.ingestedEmailModel
      .find({
        threadId,
        $or: [{ userId }, { sharedWithUsers: userId }, { visibilityLevel: 'organization' }],
      })
      .sort({ receivedAt: 1 });

    return results.map(result => result.toJSON());
  }

  async findByUserIdWithPagination(userId: string, limit: number, offset: number): Promise<IIngestedEmailDocument[]> {
    const results = await this.ingestedEmailModel.find({ userId }).sort({ receivedAt: -1 }).skip(offset).limit(limit);

    return results.map(result => result.toJSON());
  }

  async findVisibleToUser(userId: string, organizationId?: string): Promise<IIngestedEmailDocument[]> {
    const query: mongoose.FilterQuery<IIngestedEmail> = {
      $or: [
        { userId }, // User's own emails
        { sharedWithUsers: userId }, // Shared with user
        { visibilityLevel: 'organization', organizationId }, // Organization-wide
      ],
    };

    const results = await this.ingestedEmailModel.find(query).sort({ receivedAt: -1 });

    return results.map(result => result.toJSON());
  }

  async releaseEmbargo(emailId: string): Promise<void> {
    await this.ingestedEmailModel.findByIdAndUpdate(emailId, {
      visibilityLevel: 'team',
      embargoUntil: null,
    });
  }

  async findEmbargoedEmailsReadyForRelease(): Promise<IIngestedEmailDocument[]> {
    const now = new Date();
    const results = await this.ingestedEmailModel.find({
      embargoUntil: { $lte: now },
      visibilityLevel: 'private',
    });

    return results.map(result => result.toJSON());
  }

  async findByPlatformEmailAddress(platformEmailAddress: string): Promise<IIngestedEmailDocument[]> {
    const results = await this.ingestedEmailModel.find({ platformEmailAddress }).sort({ receivedAt: -1 });

    return results.map(result => result.toJSON());
  }
}

export const ingestedEmailRepository = new IngestedEmailRepository(IngestedEmailModel);

export { IngestedEmailModel };
export default IngestedEmailModel;
