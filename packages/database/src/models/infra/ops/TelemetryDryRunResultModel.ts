import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export type DryRunSource = 'test' | 'real';
export type DryRunPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface ITelemetrySummary {
  anomalyScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  primaryAnomaly: string;
  modelId: string;
  provider: string;
}

export interface IDryRunAction {
  wouldCreateIssue: boolean;
  issueTitle?: string;
  priority: DryRunPriority;
  labels: string[];
  isRegression: boolean;
  regressedFromIssue?: number;
  isDuplicate: boolean;
  matchedIssueNumber?: number;
  wouldSendSlackAlert: boolean;
  slackChannelId?: string;
}

export interface ITelemetryDryRunResultDocument extends IMongoDocument {
  timestamp: Date;
  source: DryRunSource;
  questId?: string;
  telemetrySummary: ITelemetrySummary;
  action: IDryRunAction;
  fingerprint: string;
  semanticFingerprint: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TelemetryDryRunResultSchema = new mongoose.Schema<ITelemetryDryRunResultDocument>(
  {
    timestamp: { type: Date, required: true, default: () => new Date(), index: true },
    source: { type: String, enum: ['test', 'real'], required: true, index: true },
    questId: { type: String, index: true },
    telemetrySummary: {
      anomalyScore: { type: Number, required: true },
      severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], required: true },
      primaryAnomaly: { type: String, required: true },
      modelId: { type: String, required: true },
      provider: { type: String, required: true },
    },
    action: {
      wouldCreateIssue: { type: Boolean, required: true },
      issueTitle: { type: String },
      priority: { type: String, enum: ['P0', 'P1', 'P2', 'P3'], required: true },
      labels: [{ type: String }],
      isRegression: { type: Boolean, required: true },
      regressedFromIssue: { type: Number },
      isDuplicate: { type: Boolean, required: true },
      matchedIssueNumber: { type: Number },
      wouldSendSlackAlert: { type: Boolean, required: true },
      slackChannelId: { type: String },
    },
    fingerprint: { type: String, required: true, index: true },
    semanticFingerprint: { type: String, required: true },
    // TTL index - MongoDB will automatically delete documents when expiresAt is reached
    expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
  },
  { timestamps: true }
);

// Add compound index for querying by source and timestamp
TelemetryDryRunResultSchema.index({ source: 1, timestamp: -1 });

export const TelemetryDryRunResult: Model<ITelemetryDryRunResultDocument> =
  mongoose.models.TelemetryDryRunResult ||
  mongoose.model<ITelemetryDryRunResultDocument>('TelemetryDryRunResult', TelemetryDryRunResultSchema);

export class TelemetryDryRunResultRepository extends BaseRepository<ITelemetryDryRunResultDocument> {
  // Default TTL of 24 hours
  private static readonly DEFAULT_TTL_HOURS = 24;

  constructor(model: Model<ITelemetryDryRunResultDocument>) {
    super(model);
  }

  /**
   * Create a dry run result with automatic expiration
   */
  async createResult(
    data: Omit<ITelemetryDryRunResultDocument, 'id' | 'createdAt' | 'updatedAt' | 'expiresAt' | 'timestamp'> & {
      timestamp?: Date;
      ttlHours?: number;
    }
  ): Promise<ITelemetryDryRunResultDocument> {
    const ttlHours = data.ttlHours ?? TelemetryDryRunResultRepository.DEFAULT_TTL_HOURS;
    const timestamp = data.timestamp ?? new Date();
    const expiresAt = new Date(timestamp.getTime() + ttlHours * 60 * 60 * 1000);

    return this.model.create({
      ...data,
      timestamp,
      expiresAt,
    });
  }

  /**
   * Get recent dry run results, optionally filtered by source
   */
  async findRecent(options?: {
    limit?: number;
    source?: DryRunSource | 'all';
  }): Promise<ITelemetryDryRunResultDocument[]> {
    const limit = Math.min(options?.limit ?? 20, 100);
    const sourceFilter = options?.source && options.source !== 'all' ? { source: options.source } : {};

    return this.model.find(sourceFilter).sort({ timestamp: -1 }).limit(limit).exec();
  }

  /**
   * Count total results, optionally filtered by source
   */
  async countResults(source?: DryRunSource | 'all'): Promise<number> {
    const sourceFilter = source && source !== 'all' ? { source } : {};
    return this.model.countDocuments(sourceFilter).exec();
  }

  /**
   * Delete all expired results (normally handled by TTL index, but can be called manually)
   */
  async deleteExpired(): Promise<number> {
    const result = await this.model.deleteMany({
      expiresAt: { $lt: new Date() },
    });
    return result.deletedCount;
  }
}

export const telemetryDryRunResultRepository = new TelemetryDryRunResultRepository(TelemetryDryRunResult);
