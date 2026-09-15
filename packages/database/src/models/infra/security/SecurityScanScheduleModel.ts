import { IMongoDocument } from '@bike4mind/common';
import mongoose, { Model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';

export type SecurityScanType = 'web' | 'code' | 'packages' | 'secrets' | 'cloud' | 'waf';

export interface ISecurityScanScheduleDocument extends IMongoDocument {
  stage: string;
  scanType: SecurityScanType;
  enabled: boolean;
  // Fixed schedule: Sunday at 2AM UTC
  dayOfWeek: number; // 0 = Sunday
  timeOfDay: string; // HH:MM format (e.g., '02:00')
  lastRunAt?: Date;
  nextRunAt?: Date;
  createdBy: string; // Admin user ID who created/enabled the schedule
  createdAt: Date;
  updatedAt: Date;
}

const SecurityScanScheduleSchema = new mongoose.Schema<ISecurityScanScheduleDocument>(
  {
    stage: {
      type: String,
      required: true,
      index: true,
      // Validate stage name format to prevent injection
      validate: {
        validator: (value: string) => /^[a-z0-9-]+$/i.test(value),
        message: 'Stage name must contain only alphanumeric characters and hyphens',
      },
    },
    scanType: {
      type: String,
      required: true,
      enum: ['web', 'code', 'packages', 'secrets', 'cloud', 'waf'],
      index: true,
    },
    enabled: {
      type: Boolean,
      required: true,
      default: false,
      index: true,
    },
    dayOfWeek: {
      type: Number,
      required: true,
      default: 0, // Sunday
      min: 0,
      max: 6,
    },
    timeOfDay: {
      type: String,
      required: true,
      default: '02:00', // 2:00 AM UTC
      // Validate HH:MM format
      validate: {
        validator: (value: string) => /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(value),
        message: 'Time must be in HH:MM format (e.g., 02:00)',
      },
    },
    lastRunAt: {
      type: Date,
      default: null,
    },
    nextRunAt: {
      type: Date,
      default: null,
      index: true, // Important for cron job queries
    },
    createdBy: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Compound index for uniqueness: one schedule per stage+scanType combination
SecurityScanScheduleSchema.index({ stage: 1, scanType: 1 }, { unique: true });

// Compound index for efficient cron job queries
// Find all enabled schedules where nextRunAt <= now
SecurityScanScheduleSchema.index({ enabled: 1, nextRunAt: 1 });

export const SecurityScanSchedule: Model<ISecurityScanScheduleDocument> =
  mongoose.models.SecurityScanSchedule ||
  mongoose.model<ISecurityScanScheduleDocument>('SecurityScanSchedule', SecurityScanScheduleSchema);

export class SecurityScanScheduleRepository extends BaseRepository<ISecurityScanScheduleDocument> {
  constructor(model: Model<ISecurityScanScheduleDocument>) {
    super(model);
  }

  /**
   * Find a schedule by stage and scan type
   */
  async findByStageAndScanType(
    stage: string,
    scanType: SecurityScanType
  ): Promise<ISecurityScanScheduleDocument | null> {
    const doc = await this.model.findOne({ stage, scanType }).exec();
    return doc ? (doc.toJSON() as ISecurityScanScheduleDocument) : null;
  }

  /**
   * Find all enabled schedules where nextRunAt is in the past (due to run)
   * Used by the cron job to determine which scans to trigger
   */
  async findDueScans(now: Date): Promise<ISecurityScanScheduleDocument[]> {
    const docs = await this.model
      .find({
        enabled: true,
        nextRunAt: { $lte: now },
      })
      .sort({ nextRunAt: 1 }) // Process oldest due scans first
      .exec();

    return docs.map(doc => doc.toJSON() as ISecurityScanScheduleDocument);
  }

  /**
   * Find all schedules for a specific stage
   */
  async findByStage(stage: string): Promise<ISecurityScanScheduleDocument[]> {
    const docs = await this.model.find({ stage }).sort({ scanType: 1 }).exec();
    return docs.map(doc => doc.toJSON() as ISecurityScanScheduleDocument);
  }

  /**
   * Update a schedule by ID
   */
  async updateById(id: string, update: Partial<ISecurityScanScheduleDocument>): Promise<void> {
    await this.model.updateOne({ _id: id }, { $set: update }).exec();
  }

  /**
   * Update or create a schedule (upsert pattern)
   */
  async upsert(
    stage: string,
    scanType: SecurityScanType,
    data: Partial<ISecurityScanScheduleDocument>
  ): Promise<ISecurityScanScheduleDocument> {
    const doc = await this.model
      .findOneAndUpdate(
        { stage, scanType },
        { $set: data },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
        }
      )
      .exec();

    if (!doc) {
      throw new Error('Failed to upsert security scan schedule');
    }

    return doc.toJSON() as ISecurityScanScheduleDocument;
  }
}

export const securityScanScheduleRepository = new SecurityScanScheduleRepository(SecurityScanSchedule);
