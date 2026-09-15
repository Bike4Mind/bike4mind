import mongoose, { Document, Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export interface IRapidReplyResultDocument extends Document {
  id: string;
  questId?: string;
  sessionId?: string;
  userId: string;
  mainModelId: string;
  rapidModelId: string;
  mappingId: string;
  promptId?: string;
  rapidResponse: {
    content: string;
    tokenCount: number;
    latency: number; // in milliseconds
    cost?: number;
    ttfvt?: number; // in milliseconds
  };
  mainResponse?: {
    content: string;
    tokenCount: number;
    latency: number;
    cost?: number;
    ttfvt?: number; // in milliseconds
  };
  userInteraction: {
    wasShown: boolean;
    wasReplaced: boolean;
    userFeedback?: 'positive' | 'negative' | 'neutral';
    replacementTime?: number; // ms after rapid response
  };
  metrics: {
    totalLatency: number;
    latencySavings: number;
    ttfvtSavings?: number; // in milliseconds
    userExperienceScore?: number; // 1-10
    qualityScore?: number; // 1-10
  };
  status: 'success' | 'failed' | 'timeout' | 'replaced';
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IRapidReplyResultRepository {
  findAll(limit?: number): Promise<IRapidReplyResultDocument[]>;
  findById(id: string): Promise<IRapidReplyResultDocument | null>;
  findByQuestId(questId: string): Promise<IRapidReplyResultDocument | null>;
  findBySessionId(sessionId: string): Promise<IRapidReplyResultDocument[]>;
  findByUserId(userId: string, limit?: number): Promise<IRapidReplyResultDocument[]>;
  findByDateRange(startDate: Date, endDate: Date): Promise<IRapidReplyResultDocument[]>;
  findLatestBlankRapidReplyBySessionId(sessionId: string): Promise<IRapidReplyResultDocument | null>;
  createResult(data: Partial<IRapidReplyResultDocument>): Promise<IRapidReplyResultDocument>;
  updateResult(id: string, data: Partial<IRapidReplyResultDocument>): Promise<IRapidReplyResultDocument | null>;
  updateResultByQuestId(
    questId: string,
    data: Partial<IRapidReplyResultDocument>
  ): Promise<IRapidReplyResultDocument | null>;
  getMetrics(filters?: {
    startDate?: Date;
    endDate?: Date;
    mainModelId?: string;
    rapidModelId?: string;
    userId?: string;
  }): Promise<{
    totalRequests: number;
    successRate: number;
    averageLatency: number;
    averageLatencySavings: number;
    averageUserExperienceScore?: number;
    averageQualityScore?: number;
    modelPairStats: Array<{
      mainModelId: string;
      rapidModelId: string;
      count: number;
      successRate: number;
      averageLatency: number;
    }>;
  }>;
  cleanupOldResults(olderThanDays: number): Promise<number>;
}

const RapidReplyResultSchema = new Schema<IRapidReplyResultDocument>(
  {
    questId: { type: String, required: false },
    sessionId: { type: String, required: false },
    userId: { type: String, required: true },
    mainModelId: { type: String, required: true },
    rapidModelId: { type: String, required: true },
    mappingId: { type: String, required: true },
    promptId: { type: String },
    rapidResponse: {
      content: { type: String, required: true },
      tokenCount: { type: Number, required: true },
      latency: { type: Number, required: true },
      cost: { type: Number },
      ttfvt: { type: Number },
    },
    mainResponse: {
      content: { type: String },
      tokenCount: { type: Number },
      latency: { type: Number },
      cost: { type: Number },
    },
    userInteraction: {
      wasShown: { type: Boolean, default: true },
      wasReplaced: { type: Boolean, default: false },
      userFeedback: { type: String, enum: ['positive', 'negative', 'neutral'] },
      replacementTime: { type: Number },
    },
    metrics: {
      totalLatency: { type: Number, required: true },
      latencySavings: { type: Number, required: true },
      ttfvtSavings: { type: Number },
      userExperienceScore: { type: Number, min: 1, max: 10 },
      qualityScore: { type: Number, min: 1, max: 10 },
    },
    status: {
      type: String,
      enum: ['success', 'failed', 'timeout', 'replaced'],
      required: true,
    },
    errorMessage: { type: String },
  },
  {
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
    timestamps: true,
    versionKey: false,
  }
);

// Indexes for performance
// Sparse index on questId - only indexes documents where questId is set
RapidReplyResultSchema.index({ questId: 1 }, { sparse: true });
RapidReplyResultSchema.index({ sessionId: 1 });
RapidReplyResultSchema.index({ userId: 1 });
RapidReplyResultSchema.index({ createdAt: -1 });
RapidReplyResultSchema.index({ mainModelId: 1, rapidModelId: 1 });
RapidReplyResultSchema.index({ status: 1 });

// TTL index to auto-delete old results after 30 days
RapidReplyResultSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30 days
);

class RapidReplyResultRepository
  extends BaseRepository<IRapidReplyResultDocument>
  implements IRapidReplyResultRepository
{
  constructor() {
    super(RapidReplyResultModel);
  }

  async findAll(limit = 100): Promise<IRapidReplyResultDocument[]> {
    return this.model.find({}).sort({ createdAt: -1 }).limit(limit);
  }

  async findById(id: string): Promise<IRapidReplyResultDocument | null> {
    return this.model.findById(id);
  }

  async findByQuestId(questId: string): Promise<IRapidReplyResultDocument | null> {
    return this.model.findOne({ questId });
  }

  async findBySessionId(sessionId: string): Promise<IRapidReplyResultDocument[]> {
    return this.model.find({ sessionId }).sort({ createdAt: -1 });
  }

  async findLatestBlankRapidReplyBySessionId(sessionId: string): Promise<IRapidReplyResultDocument | null> {
    const tenSecondsAgo = new Date(Date.now() - 10 * 1000);
    return this.model
      .findOne({
        sessionId,
        $or: [{ questId: null }, { questId: { $exists: false } }],
        createdAt: { $gte: tenSecondsAgo },
      })
      .sort({ createdAt: -1 });
  }

  async findByUserId(userId: string, limit = 50): Promise<IRapidReplyResultDocument[]> {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit);
  }

  async findByDateRange(startDate: Date, endDate: Date): Promise<IRapidReplyResultDocument[]> {
    return this.model
      .find({
        createdAt: {
          $gte: startDate,
          $lte: endDate,
        },
      })
      .sort({ createdAt: -1 });
  }

  async createResult(data: Partial<IRapidReplyResultDocument>): Promise<IRapidReplyResultDocument> {
    try {
      console.log('🔍🔍🔍 Creating rapid reply result with data:', JSON.stringify(data, null, 2), '🔍🔍🔍');
      const result = await this.model.create(data);
      return result.toJSON() as unknown as IRapidReplyResultDocument;
    } catch (error) {
      console.error('❌ Failed to create rapid reply result:', error);
      console.error('📋 Data that failed:', JSON.stringify(data, null, 2));
      // don't throw error
      return null as unknown as IRapidReplyResultDocument;
    }
  }

  async updateResult(id: string, data: Partial<IRapidReplyResultDocument>): Promise<IRapidReplyResultDocument | null> {
    const result = await this.model.findByIdAndUpdate(id, data, { new: true });
    return result?.toJSON() as unknown as IRapidReplyResultDocument | null;
  }

  async updateResultByQuestId(
    questId: string,
    data: Partial<IRapidReplyResultDocument>
  ): Promise<IRapidReplyResultDocument | null> {
    try {
      const result = await this.model.findOneAndUpdate({ questId }, data, { new: true });
      return result?.toJSON() as unknown as IRapidReplyResultDocument | null;
    } catch (error) {
      console.error('❌ Failed to update rapid reply result:', error);
      console.error('📋 Data that failed:', JSON.stringify(data, null, 2));
      // don't throw error
      return null as unknown as IRapidReplyResultDocument;
    }
  }

  async getMetrics(
    filters: {
      startDate?: Date;
      endDate?: Date;
      mainModelId?: string;
      rapidModelId?: string;
      userId?: string;
    } = {}
  ): Promise<{
    totalRequests: number;
    successRate: number;
    averageLatency: number;
    averageLatencySavings: number;
    averageTtfvtSavings?: number;
    averageTtfvt?: number;
    averageUserExperienceScore?: number;
    averageQualityScore?: number;
    modelPairStats: Array<{
      mainModelId: string;
      rapidModelId: string;
      count: number;
      successRate: number;
      averageLatency: number;
      averageTtfvtSavings?: number;
      averageTtfvt?: number;
    }>;
  }> {
    const matchConditions: {
      createdAt?: {
        $gte?: Date;
        $lte?: Date;
      };
      mainModelId?: string;
      rapidModelId?: string;
      userId?: string;
    } = {};

    if (filters.startDate || filters.endDate) {
      matchConditions.createdAt = {};
      if (filters.startDate) matchConditions.createdAt.$gte = filters.startDate;
      if (filters.endDate) matchConditions.createdAt.$lte = filters.endDate;
    }

    if (filters.mainModelId) matchConditions.mainModelId = filters.mainModelId;
    if (filters.rapidModelId) matchConditions.rapidModelId = filters.rapidModelId;
    if (filters.userId) matchConditions.userId = filters.userId;

    const [overallStats, modelPairStats] = await Promise.all([
      // Overall statistics
      this.model.aggregate([
        { $match: matchConditions },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            successfulRequests: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            avgLatency: { $avg: '$metrics.totalLatency' },
            avgLatencySavings: { $avg: '$metrics.latencySavings' },
            avgTtfvtSavings: {
              $avg: {
                $cond: [
                  { $and: [{ $gt: ['$metrics.ttfvtSavings', 0] }, { $ne: ['$metrics.ttfvtSavings', null] }] },
                  '$metrics.ttfvtSavings',
                  null,
                ],
              },
            },
            avgTtfvt: {
              $avg: {
                $cond: [
                  { $and: [{ $gt: ['$rapidResponse.ttfvt', 0] }, { $ne: ['$rapidResponse.ttfvt', null] }] },
                  '$rapidResponse.ttfvt',
                  null,
                ],
              },
            },
            avgUserExperienceScore: { $avg: '$metrics.userExperienceScore' },
            avgQualityScore: { $avg: '$metrics.qualityScore' },
          },
        },
      ]),

      // Model pair statistics
      this.model.aggregate([
        { $match: matchConditions },
        {
          $group: {
            _id: { mainModelId: '$mainModelId', rapidModelId: '$rapidModelId' },
            count: { $sum: 1 },
            successfulCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            avgLatency: { $avg: '$metrics.totalLatency' },
            avgTtfvtSavings: {
              $avg: {
                $cond: [
                  { $and: [{ $gt: ['$metrics.ttfvtSavings', 0] }, { $ne: ['$metrics.ttfvtSavings', null] }] },
                  '$metrics.ttfvtSavings',
                  null,
                ],
              },
            },
            avgTtfvt: {
              $avg: {
                $cond: [
                  { $and: [{ $gt: ['$rapidResponse.ttfvt', 0] }, { $ne: ['$rapidResponse.ttfvt', null] }] },
                  '$rapidResponse.ttfvt',
                  null,
                ],
              },
            },
          },
        },
        {
          $project: {
            mainModelId: '$_id.mainModelId',
            rapidModelId: '$_id.rapidModelId',
            count: 1,
            successRate: { $multiply: [{ $divide: ['$successfulCount', '$count'] }, 100] },
            averageLatency: '$avgLatency',
            averageTtfvtSavings: '$avgTtfvtSavings',
            averageTtfvt: '$avgTtfvt',
            _id: 0,
          },
        },
        { $sort: { count: -1 } },
      ]),
    ]);

    const overall = overallStats[0] || {
      totalRequests: 0,
      successfulRequests: 0,
      avgLatency: 0,
      avgLatencySavings: 0,
      avgTtfvt: 0,
    };

    return {
      totalRequests: overall.totalRequests,
      successRate: overall.totalRequests > 0 ? (overall.successfulRequests / overall.totalRequests) * 100 : 0,
      averageLatency: overall.avgLatency || 0,
      averageLatencySavings: overall.avgLatencySavings || 0,
      averageTtfvtSavings: overall.avgTtfvtSavings || 0,
      averageTtfvt: overall.avgTtfvt || 0,
      averageUserExperienceScore: overall.avgUserExperienceScore,
      averageQualityScore: overall.avgQualityScore,
      modelPairStats: modelPairStats,
    };
  }

  async cleanupOldResults(olderThanDays: number): Promise<number> {
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const result = await this.model.deleteMany({ createdAt: { $lt: cutoffDate } });
    return result.deletedCount || 0;
  }
}

export const RapidReplyResultModel: Model<IRapidReplyResultDocument> =
  (mongoose.models.RapidReplyResult as unknown as Model<IRapidReplyResultDocument>) ??
  model<IRapidReplyResultDocument>('RapidReplyResult', RapidReplyResultSchema);

export const rapidReplyResultRepository = new RapidReplyResultRepository();
