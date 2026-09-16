import mongoose, { Model, Schema } from 'mongoose';
import type {
  IDataLakeResearchRun,
  IDataLakeResearchRunDocument,
  IDataLakeResearchRunRepository,
  ResearchRunTotals,
  SettleResearchRunInput,
} from '@bike4mind/common';
import {
  emptyResearchRunTotals,
  RESEARCH_RUN_STALE_AFTER_MS,
  RESEARCH_RUN_STATUSES,
  RESEARCH_RUN_STOP_REASONS,
  RESEARCH_RUN_TRIGGERS,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeResearchRun';

interface IDataLakeResearchRunModel extends Model<IDataLakeResearchRunDocument> {}

/** The levers as executed. Mirrors `ResearchRunLevers`; see DataLakeResearchTypes.ts. */
const ResearchRunLeversSchema = {
  query: { type: String, required: true },
  model: { type: String },
  maxResults: { type: Number, required: true },
  maxProposals: { type: Number, required: true },
  recencyDays: { type: Number, default: null },
  allowedDomains: { type: [String], default: [] },
  blockedDomains: { type: [String], default: [] },
  minRelevance: { type: Number, required: true },
  costCeilingMicroUsd: { type: Number, required: true },
  proposedTags: { type: [String], default: [] },
};

const ResearchRunTotalsSchema = {
  searchHits: { type: Number, default: 0 },
  filteredBySource: { type: Number, default: 0 },
  belowRelevance: { type: Number, default: 0 },
  judgeFailed: { type: Number, default: 0 },
  fetchFailed: { type: Number, default: 0 },
  proposed: { type: Number, default: 0 },
  duplicatePending: { type: Number, default: 0 },
  alreadyInLake: { type: Number, default: 0 },
  suppressedByTombstone: { type: Number, default: 0 },
  unusableSource: { type: Number, default: 0 },
};

/**
 * One execution of a saved research config (#1682). The row is what a proposal's
 * `provenance.runId` points back at, so it outlives the config it ran from and answers "where did
 * this come from and what did it cost" for as long as the lake holds the file.
 */
const DataLakeResearchRunSchema = new Schema<IDataLakeResearchRunDocument>(
  {
    dataLakeId: { type: String, required: true },
    configId: { type: String, required: true },
    levers: { type: ResearchRunLeversSchema, required: true },
    trigger: { type: String, enum: RESEARCH_RUN_TRIGGERS, required: true },
    startedByUserId: { type: String, default: null },
    status: { type: String, enum: RESEARCH_RUN_STATUSES, required: true, default: 'queued' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    stopReason: { type: String, enum: RESEARCH_RUN_STOP_REASONS, default: null },
    spentMicroUsd: { type: Number, default: 0 },
    totals: { type: ResearchRunTotalsSchema, default: () => emptyResearchRunTotals() },
    error: { type: String, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// One lake's run history, newest first - the panel's only list read.
DataLakeResearchRunSchema.index({ dataLakeId: 1, createdAt: -1 });
// The rate-limit count: how many runs this lake started in a window.
DataLakeResearchRunSchema.index({ dataLakeId: 1, status: 1, createdAt: -1 });

export const DataLakeResearchRunModel: IDataLakeResearchRunModel =
  (mongoose.models[ModelName] as IDataLakeResearchRunModel) ||
  mongoose.model<IDataLakeResearchRunDocument, IDataLakeResearchRunModel>(ModelName, DataLakeResearchRunSchema);

class DataLakeResearchRunRepository
  extends BaseRepository<IDataLakeResearchRunDocument>
  implements IDataLakeResearchRunRepository
{
  constructor(private runModel: mongoose.Model<IDataLakeResearchRunDocument>) {
    super(runModel);
  }

  async createRun(
    input: Omit<IDataLakeResearchRun, 'status' | 'spentMicroUsd' | 'totals'>
  ): Promise<IDataLakeResearchRunDocument> {
    const doc = await this.runModel.create({
      ...input,
      status: 'queued',
      spentMicroUsd: 0,
      totals: emptyResearchRunTotals(),
    });
    return doc.toJSON() as IDataLakeResearchRunDocument;
  }

  async listByLake(dataLakeId: string, options?: { limit?: number }): Promise<IDataLakeResearchRunDocument[]> {
    const query = this.runModel.find({ dataLakeId }).sort({ createdAt: -1 });
    if (options?.limit) query.limit(options.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as IDataLakeResearchRunDocument);
  }

  async findByIdInLake(id: string, dataLakeId: string): Promise<IDataLakeResearchRunDocument | null> {
    const doc = await this.runModel.findOne({ _id: id, dataLakeId }).catch(() => null);
    return (doc?.toJSON() as IDataLakeResearchRunDocument) ?? null;
  }

  async claimForExecution(id: string, startedAt: Date): Promise<IDataLakeResearchRunDocument | null> {
    // `status: 'queued'` in the FILTER is the whole at-least-once guard. Never a read then a write:
    // SQS redelivers, and a second pass over the loop would spend a second ceiling.
    //
    // Deliberately NOT a blanket `.catch(() => null)`. Null here means "the row was not queued",
    // and the handler treats that as work already done: it returns successfully and SQS deletes
    // the message. Reporting a connect timeout or a stepdown that way would leave the row `queued`
    // with nothing left to redeliver it, and `countActiveByLake` would then refuse every later run
    // on the lake. A fault has to propagate so the handler rethrows and SQS retries.
    //
    // A malformed id is the one exception, and it is not a fault: it is a definitive answer that
    // no such row exists, deterministic across every redelivery, so throwing it would only buy a
    // DLQ entry. Guarded ahead of the query the way `ModelDiscoveryRunModel.runById` does it,
    // rather than caught after, so the two cases can never be confused for one another.
    if (!mongoose.isValidObjectId(id)) return null;

    const doc = await this.runModel.findOneAndUpdate(
      { _id: id, status: 'queued' },
      { $set: { status: 'running', startedAt } },
      { new: true }
    );
    return (doc?.toJSON() as IDataLakeResearchRunDocument) ?? null;
  }

  async settleRun(id: string, input: SettleResearchRunInput): Promise<void> {
    const { status, completedAt, stopReason, spentMicroUsd, totals, error } = input;
    await this.runModel.updateOne(
      { _id: id },
      {
        $set: {
          status,
          completedAt,
          stopReason: stopReason ?? null,
          spentMicroUsd,
          totals,
          error: error ?? null,
        },
      }
    );
  }

  async recordProgress(id: string, spentMicroUsd: number, totals: ResearchRunTotals): Promise<void> {
    await this.runModel.updateOne({ _id: id }, { $set: { spentMicroUsd, totals } });
  }

  async countStartedSince(dataLakeId: string, since: Date): Promise<number> {
    return this.runModel.countDocuments({ dataLakeId, createdAt: { $gte: since } });
  }

  /**
   * Rows that still hold the one-at-a-time guard shut.
   *
   * Bounded by AGE, because nothing reaps a run whose catch never executed - a hard Lambda timeout,
   * an OOM, a container replaced mid-run all leave `running` behind, and a message that dies before
   * its handler leaves `queued`. An unbounded count would turn any of those into a permanent
   * lockout: no cancel endpoint, no reaper cron, no admin surface back. Past the bound SQS has
   * already redelivered and given up, so a row still in either state is abandoned, not in flight.
   *
   * MUST STAY IN SYNC with `isResearchRunInFlight` (`DataLakeResearchTypes.ts`), the in-memory
   * spelling of this query that the run history and the "Run now" button read. If the two drift,
   * the UI locks out a lake this count would let start a run.
   */
  async countActiveByLake(dataLakeId: string): Promise<number> {
    const activeSince = new Date(Date.now() - RESEARCH_RUN_STALE_AFTER_MS);
    return this.runModel.countDocuments({
      dataLakeId,
      $or: [
        { status: 'running', startedAt: { $gte: activeSince } },
        { status: 'queued', createdAt: { $gte: activeSince } },
      ],
    });
  }

  async deleteForLake(dataLakeId: string): Promise<number> {
    const res = await this.runModel.deleteMany({ dataLakeId });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeResearchRunRepository = new DataLakeResearchRunRepository(DataLakeResearchRunModel);
