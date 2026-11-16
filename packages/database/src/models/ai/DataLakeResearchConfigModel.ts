import mongoose, { Model, Schema } from 'mongoose';
import type {
  CreateDataLakeResearchConfigInput,
  IDataLakeResearchConfigDocument,
  IDataLakeResearchConfigRepository,
  ResearchFeedCursor,
  ResearchScheduleCadence,
  ResearchScheduleOutcome,
  UpdateDataLakeResearchConfigInput,
} from '@bike4mind/common';
import {
  RESEARCH_MAX_AUTO_ADMITS_DEFAULT,
  RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT,
  RESEARCH_RUN_TRIGGERS,
  RESEARCH_SOURCES,
  RESEARCH_SCHEDULE_CADENCES,
  RESEARCH_SCHEDULE_SKIP_REASONS,
  RESEARCH_UNLISTED_SOURCES,
  upgradeLegacyResearchLevers,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeResearchConfig';

interface IDataLakeResearchConfigModel extends Model<IDataLakeResearchConfigDocument> {}

// One flat shape for every arm of the ResearchScheduleOutcome union; which fields are set depends
// on `outcome`.
const ResearchScheduleOutcomeSchema = new Schema(
  {
    outcome: { type: String, enum: ['started', 'skipped', 'failed'], required: true },
    at: { type: Date, required: true },
    runId: { type: String },
    reason: { type: String, enum: RESEARCH_SCHEDULE_SKIP_REASONS },
    pendingProposals: { type: Number },
    reviewBacklogLimit: { type: Number },
    error: { type: String },
  },
  { _id: false }
);

// Run output written back after a feed run; never snapshotted on a run and never edited through the API.
const ResearchFeedCursorSchema = new Schema(
  {
    fingerprint: { type: String, required: true },
    feedUrlKey: { type: String },
    newestPublishedAt: { type: Date, default: null },
    seenKeys: { type: [String], default: [] },
    retries: {
      type: [
        new Schema(
          { key: { type: String, required: true }, attempts: { type: Number, required: true } },
          { _id: false }
        ),
      ],
      default: [],
    },
  },
  { _id: false }
);

/**
 * One saved, reusable research-run configuration for one lake (#1682). See
 * DataLakeResearchTypes.ts for what each lever means and why the bounds are where they are.
 *
 * Every lever is `required` with a schema-level default rather than optional: a config written by
 * an older client and then RUN would otherwise reach the loop with `undefined` where a number is
 * expected, and the loop's own clamps would read that as "no limit" on exactly the fields that
 * bound spend.
 */
const DataLakeResearchConfigSchema = new Schema<IDataLakeResearchConfigDocument>(
  {
    dataLakeId: { type: String, required: true },
    name: { type: String, required: true },
    // Absent on a stored config reads as search; see `upgradeLegacyResearchLevers`.
    source: { type: String, enum: RESEARCH_SOURCES, default: 'search' },
    feedUrl: { type: String, default: null },
    query: { type: String, required: true },
    // No default: absent means "the service's current default model", which is deliberately
    // resolved at run time so a retired model does not strand a saved config.
    model: { type: String },
    maxResults: { type: Number, required: true },
    maxProposals: { type: Number, required: true },
    recencyDays: { type: Number, default: null },
    trustedDomains: { type: [String], default: [] },
    reviewDomains: { type: [String], default: [] },
    // No default: its absence is how a document written before the tiers is recognized and upgraded.
    unlistedSources: { type: String, enum: RESEARCH_UNLISTED_SOURCES },
    autoAdmitTrusted: { type: Boolean, default: false },
    maxAutoAdmits: { type: Number, default: RESEARCH_MAX_AUTO_ADMITS_DEFAULT },
    // Derived from the three fields above on every write; kept for readers that predate them.
    allowedDomains: { type: [String], default: [] },
    blockedDomains: { type: [String], default: [] },
    minRelevance: { type: Number, required: true },
    costCeilingMicroUsd: { type: Number, required: true },
    proposedTags: { type: [String], default: [] },
    trigger: { type: String, enum: RESEARCH_RUN_TRIGGERS, required: true },
    // Defaults rather than `required`, so configs saved before scheduling existed read as unscheduled.
    cadence: { type: String, enum: RESEARCH_SCHEDULE_CADENCES, default: 'off' },
    reviewBacklogLimit: { type: Number, default: RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT },
    nextRunAt: { type: Date, default: null },
    scheduleAnchorAt: { type: Date, default: null },
    lastScheduledOutcome: { type: ResearchScheduleOutcomeSchema, default: null },
    createdByUserId: { type: String, required: true },
    lastUpdatedByUserId: { type: String, default: null },
    lastRunAt: { type: Date, default: null },
    feedCursor: { type: ResearchFeedCursorSchema, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One lake's configs, newest first.
DataLakeResearchConfigSchema.index({ dataLakeId: 1, createdAt: -1 });
// The research scheduler's due-config scan (claimDueConfigs).
DataLakeResearchConfigSchema.index({ nextRunAt: 1 });

export const DataLakeResearchConfigModel: IDataLakeResearchConfigModel =
  (mongoose.models[ModelName] as IDataLakeResearchConfigModel) ||
  mongoose.model<IDataLakeResearchConfigDocument, IDataLakeResearchConfigModel>(
    ModelName,
    DataLakeResearchConfigSchema
  );

class DataLakeResearchConfigRepository
  extends BaseRepository<IDataLakeResearchConfigDocument>
  implements IDataLakeResearchConfigRepository
{
  constructor(private configModel: mongoose.Model<IDataLakeResearchConfigDocument>) {
    super(configModel);
  }

  // Every read goes through the upgrader: self-host never runs the migration, and old code keeps
  // writing the legacy shape for a release, so stored documents come in both shapes.
  private toConfig(doc: mongoose.HydratedDocument<IDataLakeResearchConfigDocument>): IDataLakeResearchConfigDocument {
    return upgradeLegacyResearchLevers(doc.toJSON() as IDataLakeResearchConfigDocument);
  }

  async createConfig(input: CreateDataLakeResearchConfigInput): Promise<IDataLakeResearchConfigDocument> {
    const doc = await this.configModel.create(input);
    return this.toConfig(doc);
  }

  async listByLake(dataLakeId: string): Promise<IDataLakeResearchConfigDocument[]> {
    const docs = await this.configModel.find({ dataLakeId }).sort({ createdAt: -1 });
    return docs.map(d => this.toConfig(d));
  }

  async findByIdInLake(id: string, dataLakeId: string): Promise<IDataLakeResearchConfigDocument | null> {
    // `.catch(() => null)` rather than a pre-validation of `id`: findOne REJECTS on a non-ObjectId
    // string, so a caller passing a junk id would get a 500 where the honest answer is "no such
    // config". Same shape as assertLakeAccess's by-id lookup.
    const doc = await this.configModel.findOne({ _id: id, dataLakeId }).catch(() => null);
    return doc ? this.toConfig(doc) : null;
  }

  async updateConfig(
    id: string,
    dataLakeId: string,
    input: UpdateDataLakeResearchConfigInput
  ): Promise<IDataLakeResearchConfigDocument | null> {
    // `dataLakeId` in the FILTER, not just the caller's gate: it is what makes a config
    // unreachable from another lake's route even if the id leaks.
    const doc = await this.configModel
      .findOneAndUpdate({ _id: id, dataLakeId }, { $set: input }, { new: true })
      .catch(() => null);
    return doc ? this.toConfig(doc) : null;
  }

  async recordRunStarted(id: string, at: Date): Promise<void> {
    await this.configModel.updateOne({ _id: id }, { $set: { lastRunAt: at } }).catch(() => undefined);
  }

  async recordFeedCursor(id: string, feedUrl: string, cursor: ResearchFeedCursor): Promise<boolean> {
    const res = await this.configModel.updateOne({ _id: id, feedUrl }, { $set: { feedCursor: cursor } });
    return res.matchedCount > 0;
  }

  async claimDueConfigs(now: Date, leaseUntil: Date, limit: number): Promise<IDataLakeResearchConfigDocument[]> {
    const claimed: IDataLakeResearchConfigDocument[] = [];
    // One findOneAndUpdate per config rather than find-then-updateMany: each claim is its own
    // compare-and-set, so two overlapping ticks split the due set instead of both taking all of it.
    while (claimed.length < limit) {
      const doc = await this.configModel.findOneAndUpdate(
        { cadence: { $ne: 'off' }, nextRunAt: { $lte: now } },
        { $set: { nextRunAt: leaseUntil } },
        { sort: { nextRunAt: 1 }, new: false }
      );
      if (!doc) break;
      claimed.push(this.toConfig(doc));
    }
    return claimed;
  }

  async recordScheduleOutcome(
    id: string,
    claimedCadence: ResearchScheduleCadence,
    outcome: ResearchScheduleOutcome,
    nextRunAt: Date
  ): Promise<void> {
    await this.configModel.updateOne(
      { _id: id, cadence: claimedCadence },
      { $set: { lastScheduledOutcome: outcome, nextRunAt } }
    );
  }

  async deleteConfig(id: string, dataLakeId: string): Promise<boolean> {
    const res = await this.configModel.deleteOne({ _id: id, dataLakeId }).catch(() => null);
    return (res?.deletedCount ?? 0) > 0;
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const res = await this.configModel.deleteMany({ dataLakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeResearchConfigRepository = new DataLakeResearchConfigRepository(DataLakeResearchConfigModel);
