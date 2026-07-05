import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'RepoHistoricalInsights';

// Duration statistics for a task type
interface TypeDurationStats {
  medianHours: number;
  p75Hours: number;
  p90Hours: number;
  count: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// Monthly aggregation
interface MonthlyStats {
  month: string; // "2025-01"
  closedIssues: number;
  mergedPRs: number;
  avgDurationHours: number;
}

// Duration bucket for histograms
interface DurationBucket {
  label: string;
  minHours: number;
  maxHours: number;
  count: number;
  percentage: number;
}

// Contributor profile from historical data
interface ContributorProfile {
  githubLogin: string;
  jiraDisplayName?: string; // Jira display name (for Jira-sourced insights)
  jiraAccountId?: string; // Jira account ID
  name?: string;
  avatarUrl: string;

  // Velocity metrics
  velocityTier: 'LIGHTNING' | 'FORGE' | 'STRATEGIC';
  velocityMultiplier: number;
  avgDurationHours: number;

  // Activity
  totalPRs: number;
  totalIssuesResolved: number;
  avgPRSize: { additions: number; deletions: number };

  // Jira-specific time tracking (seconds -> hours stored)
  avgTimeSpentHours?: number; // From Jira worklog timespent field
  avgOriginalEstimateHours?: number; // From Jira timeoriginalestimate field

  // Strengths (inferred from labels, paths, keywords)
  strengths: string[];
  bestTaskTypes: string[];

  // Trend
  recentActivity: 'HIGH' | 'MEDIUM' | 'LOW';
  trend: 'improving' | 'stable' | 'declining';
}

// Keyword risk analysis
interface KeywordRisk {
  keyword: string;
  tier: 'EXTREME' | 'HIGH' | 'MEDIUM' | 'LOW';
  multiplier: number;
  occurrences: number;
  avgDurationHours: number;
  exampleIssues: string[];
}

// Historical stats
interface HistoricalStats {
  totalClosedIssues: number;
  totalMergedPRs: number;
  medianDurationHours: number;
  meanDurationHours: number;
  convergenceRate: number;

  byType: {
    bug?: TypeDurationStats;
    feature?: TypeDurationStats;
    task?: TypeDurationStats;
    chore?: TypeDurationStats;
    refactor?: TypeDurationStats;
  };

  byMonth: MonthlyStats[];
}

// Document interface
export interface IRepoHistoricalInsightsDocument extends IMongoDocument {
  // Identity - repository-scoped (not user-scoped)
  repoFullName: string; // e.g., "milliononmars/lumina5" or "jira:PROJ"

  // Source type - defaults to 'github' for backwards compatibility
  source?: 'github' | 'jira';

  // Analysis status
  status: 'pending' | 'analyzing' | 'complete' | 'failed';
  analysisJobId?: string;
  analysisStartedAt?: Date;
  analysisCompletedAt?: Date;
  lastAnalyzedCommit?: string;
  errorMessage?: string;

  // Historical stats
  stats: HistoricalStats;

  // Contributor profiles
  contributors: ContributorProfile[];

  // Keyword risk analysis
  keywordRisks: KeywordRisk[];

  // Duration distributions (for histograms)
  durationDistributions: {
    bug?: DurationBucket[];
    feature?: DurationBucket[];
    task?: DurationBucket[];
  };

  // Velocity improvement over time
  velocityImprovement?: {
    byYear: Record<string, number>; // year → multiplier
    overallImprovement: string;
  };

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

// Model interface
export interface IRepoHistoricalInsightsModel extends Model<IRepoHistoricalInsightsDocument> {}

// Schema definition
export const RepoHistoricalInsightsSchema = new Schema<IRepoHistoricalInsightsDocument>(
  {
    repoFullName: { type: String, required: true, unique: true },
    source: { type: String, enum: ['github', 'jira'], default: 'github' },

    status: {
      type: String,
      enum: ['pending', 'analyzing', 'complete', 'failed'],
      default: 'pending',
    },
    analysisJobId: { type: String },
    analysisStartedAt: { type: Date },
    analysisCompletedAt: { type: Date },
    lastAnalyzedCommit: { type: String },
    errorMessage: { type: String },

    stats: {
      totalClosedIssues: { type: Number, default: 0 },
      totalMergedPRs: { type: Number, default: 0 },
      medianDurationHours: { type: Number, default: 0 },
      meanDurationHours: { type: Number, default: 0 },
      convergenceRate: { type: Number, default: 0 },
      byType: {
        bug: {
          medianHours: { type: Number },
          p75Hours: { type: Number },
          p90Hours: { type: Number },
          count: { type: Number },
          confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        feature: {
          medianHours: { type: Number },
          p75Hours: { type: Number },
          p90Hours: { type: Number },
          count: { type: Number },
          confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        task: {
          medianHours: { type: Number },
          p75Hours: { type: Number },
          p90Hours: { type: Number },
          count: { type: Number },
          confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        chore: {
          medianHours: { type: Number },
          p75Hours: { type: Number },
          p90Hours: { type: Number },
          count: { type: Number },
          confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
        refactor: {
          medianHours: { type: Number },
          p75Hours: { type: Number },
          p90Hours: { type: Number },
          count: { type: Number },
          confidence: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        },
      },
      byMonth: [
        {
          month: { type: String },
          closedIssues: { type: Number },
          mergedPRs: { type: Number },
          avgDurationHours: { type: Number },
        },
      ],
    },

    contributors: [
      {
        githubLogin: { type: String },
        jiraDisplayName: { type: String },
        jiraAccountId: { type: String },
        name: { type: String },
        avatarUrl: { type: String },
        velocityTier: { type: String, enum: ['LIGHTNING', 'FORGE', 'STRATEGIC'] },
        velocityMultiplier: { type: Number },
        avgDurationHours: { type: Number },
        totalPRs: { type: Number },
        totalIssuesResolved: { type: Number },
        avgPRSize: {
          additions: { type: Number },
          deletions: { type: Number },
        },
        avgTimeSpentHours: { type: Number },
        avgOriginalEstimateHours: { type: Number },
        strengths: [{ type: String }],
        bestTaskTypes: [{ type: String }],
        recentActivity: { type: String, enum: ['HIGH', 'MEDIUM', 'LOW'] },
        trend: { type: String, enum: ['improving', 'stable', 'declining'] },
      },
    ],

    keywordRisks: [
      {
        keyword: { type: String },
        tier: { type: String, enum: ['EXTREME', 'HIGH', 'MEDIUM', 'LOW'] },
        multiplier: { type: Number },
        occurrences: { type: Number },
        avgDurationHours: { type: Number },
        exampleIssues: [{ type: String }],
      },
    ],

    durationDistributions: {
      bug: [
        {
          label: { type: String },
          minHours: { type: Number },
          maxHours: { type: Number },
          count: { type: Number },
          percentage: { type: Number },
        },
      ],
      feature: [
        {
          label: { type: String },
          minHours: { type: Number },
          maxHours: { type: Number },
          count: { type: Number },
          percentage: { type: Number },
        },
      ],
      task: [
        {
          label: { type: String },
          minHours: { type: Number },
          maxHours: { type: Number },
          count: { type: Number },
          percentage: { type: Number },
        },
      ],
    },

    velocityImprovement: {
      byYear: { type: Map, of: Number },
      overallImprovement: { type: String },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

export class RepoHistoricalInsightsRepository extends BaseRepository<IRepoHistoricalInsightsDocument> {
  private repoModel: IRepoHistoricalInsightsModel;

  constructor(model: IRepoHistoricalInsightsModel) {
    super(model);
    this.repoModel = model;
  }

  async findByRepo(repoFullName: string): Promise<IRepoHistoricalInsightsDocument | null> {
    return this.repoModel.findOne({ repoFullName });
  }

  async upsertByRepo(
    repoFullName: string,
    data: Partial<IRepoHistoricalInsightsDocument>
  ): Promise<IRepoHistoricalInsightsDocument> {
    return this.repoModel.findOneAndUpdate({ repoFullName }, { $set: data }, { upsert: true, new: true });
  }

  async setAnalysisStatus(
    repoFullName: string,
    status: 'pending' | 'analyzing' | 'complete' | 'failed',
    jobId?: string,
    errorMessage?: string
  ): Promise<void> {
    const update: Record<string, unknown> = { status };

    if (status === 'analyzing') {
      update.analysisStartedAt = new Date();
      update.analysisJobId = jobId;
    } else if (status === 'complete') {
      update.analysisCompletedAt = new Date();
    } else if (status === 'failed') {
      update.errorMessage = errorMessage;
    }

    await this.repoModel.updateOne({ repoFullName }, { $set: update }, { upsert: true });
  }

  async findStaleRepos(staleThresholdHours: number = 24): Promise<IRepoHistoricalInsightsDocument[]> {
    const threshold = new Date(Date.now() - staleThresholdHours * 60 * 60 * 1000);
    return this.repoModel.find({
      $or: [
        { analysisCompletedAt: { $lt: threshold } },
        { analysisCompletedAt: { $exists: false } },
        { status: 'failed' },
      ],
    });
  }

  async findByRepos(repoFullNames: string[]): Promise<IRepoHistoricalInsightsDocument[]> {
    return this.repoModel.find({ repoFullName: { $in: repoFullNames } });
  }
}

function initializeRepoHistoricalInsightsModel(): IRepoHistoricalInsightsModel {
  return (
    (mongoose.models[ModelName] as IRepoHistoricalInsightsModel) ??
    mongoose.model<IRepoHistoricalInsightsDocument, IRepoHistoricalInsightsModel>(
      ModelName,
      RepoHistoricalInsightsSchema
    )
  );
}

export const RepoHistoricalInsights = initializeRepoHistoricalInsightsModel();
export const repoHistoricalInsightsRepository = new RepoHistoricalInsightsRepository(RepoHistoricalInsights);
