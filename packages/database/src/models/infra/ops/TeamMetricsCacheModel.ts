import mongoose, { Model, Schema } from 'mongoose';
import { IMongoDocument } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'TeamMetricsCache';

interface PeriodMetrics {
  d7: number;
  d30: number;
  allTime: number;
}

interface CachedMemberMetrics {
  login: string;
  avatarUrl: string;
  profileUrl: string;
  contributions: number;
  reposContributedTo: string[];
  commits: PeriodMetrics;
  prsOpened: PeriodMetrics;
  prsMerged: PeriodMetrics;
  reviews: PeriodMetrics;
  fetchedAt: Date;
}

export interface ITeamMetricsCacheDocument extends IMongoDocument {
  userId: mongoose.Types.ObjectId;
  members: CachedMemberMetrics[];
  totalRepos: number;
  currentUserLogin?: string;
  lastFullRefresh: Date;
  refreshInProgress: boolean;
  refreshStartedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ITeamMetricsCacheModel extends Model<ITeamMetricsCacheDocument> {}

export const TeamMetricsCacheSchema = new Schema<ITeamMetricsCacheDocument>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, unique: true, index: true },
    members: [
      {
        login: { type: String, required: true },
        avatarUrl: { type: String },
        profileUrl: { type: String },
        contributions: { type: Number, default: 0 },
        reposContributedTo: [{ type: String }],
        commits: {
          d7: { type: Number, default: 0 },
          d30: { type: Number, default: 0 },
          allTime: { type: Number, default: 0 },
        },
        prsOpened: {
          d7: { type: Number, default: 0 },
          d30: { type: Number, default: 0 },
          allTime: { type: Number, default: 0 },
        },
        prsMerged: {
          d7: { type: Number, default: 0 },
          d30: { type: Number, default: 0 },
          allTime: { type: Number, default: 0 },
        },
        reviews: {
          d7: { type: Number, default: 0 },
          d30: { type: Number, default: 0 },
          allTime: { type: Number, default: 0 },
        },
        fetchedAt: { type: Date, default: Date.now },
      },
    ],
    totalRepos: { type: Number, default: 0 },
    currentUserLogin: { type: String },
    lastFullRefresh: { type: Date },
    refreshInProgress: { type: Boolean, default: false },
    refreshStartedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
  }
);

export class TeamMetricsCacheRepository extends BaseRepository<ITeamMetricsCacheDocument> {
  constructor(private teamMetricsCacheModel: ITeamMetricsCacheModel) {
    super(teamMetricsCacheModel);
  }

  async findByUserId(userId: string): Promise<ITeamMetricsCacheDocument | null> {
    return this.teamMetricsCacheModel.findOne({ userId: new mongoose.Types.ObjectId(userId) });
  }

  async upsertByUserId(userId: string, data: Partial<ITeamMetricsCacheDocument>): Promise<ITeamMetricsCacheDocument> {
    return this.teamMetricsCacheModel.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      { $set: data },
      { upsert: true, new: true }
    );
  }

  async updateMemberMetrics(
    userId: string,
    login: string,
    metrics: Omit<CachedMemberMetrics, 'login' | 'fetchedAt'>
  ): Promise<void> {
    await this.teamMetricsCacheModel.updateOne(
      { userId: new mongoose.Types.ObjectId(userId), 'members.login': login },
      {
        $set: {
          'members.$.commits': metrics.commits,
          'members.$.prsOpened': metrics.prsOpened,
          'members.$.prsMerged': metrics.prsMerged,
          'members.$.reviews': metrics.reviews,
          'members.$.fetchedAt': new Date(),
        },
      }
    );
  }

  async setRefreshInProgress(userId: string, inProgress: boolean): Promise<void> {
    await this.teamMetricsCacheModel.updateOne(
      { userId: new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          refreshInProgress: inProgress,
          ...(inProgress ? { refreshStartedAt: new Date() } : { refreshStartedAt: null }),
        },
      }
    );
  }

  async findAllWithGitHub(): Promise<ITeamMetricsCacheDocument[]> {
    // Find all caches - used by the cron job to refresh all users' metrics
    return this.teamMetricsCacheModel.find({});
  }
}

function initializeTeamMetricsCacheModel(): ITeamMetricsCacheModel {
  return (
    (mongoose.models[ModelName] as ITeamMetricsCacheModel) ??
    mongoose.model<ITeamMetricsCacheDocument, ITeamMetricsCacheModel>(ModelName, TeamMetricsCacheSchema)
  );
}

export const TeamMetricsCache = initializeTeamMetricsCacheModel();
export const teamMetricsCacheRepository = new TeamMetricsCacheRepository(TeamMetricsCache);
