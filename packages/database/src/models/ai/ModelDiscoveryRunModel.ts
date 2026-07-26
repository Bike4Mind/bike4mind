import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  DISCOVERY_RUN_HOSTS,
  DISCOVERY_RUN_STATUSES,
  DISCOVERY_RUN_TRIGGERS,
  DiscoveryRunHost,
  IModelDiscoveryRun,
  IModelDiscoveryRunDocument,
  IModelDiscoveryRunRepository,
} from '@bike4mind/common';

/** 90 days: long enough to answer "when did this model change and why". */
const RUN_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * One discovery run report: what each source returned, how well the aggregator
 * join covered the catalog, and every change the run made. This is the record
 * behind the admin status card and the source-failure alarms.
 */
const ModelDiscoveryRunSchema = new Schema<IModelDiscoveryRunDocument>(
  {
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: false },
    trigger: { type: String, required: true, enum: [...DISCOVERY_RUN_TRIGGERS] },
    host: { type: String, required: true, enum: [...DISCOVERY_RUN_HOSTS] },
    // 'partial' commits what it verified and does not advance lastSuccessfulRun,
    // so a flaky provider degrades to "no new information".
    status: { type: String, required: true, enum: [...DISCOVERY_RUN_STATUSES] },
    sources: {
      type: [
        new Schema(
          {
            name: { type: String, required: true },
            ok: { type: Boolean, required: true },
            durationMs: { type: Number, required: true },
            httpStatus: { type: Number, required: false },
            etag: { type: String, required: false },
            contentHash: { type: String, required: false },
            error: { type: String, required: false },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    joinCoverage: {
      type: [
        new Schema(
          {
            aggregator: { type: String, required: true },
            matched: { type: Number, required: true },
            total: { type: Number, required: true },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    unmatchedIds: { type: [String], required: false },
    changes: {
      type: new Schema(
        {
          added: { type: [String], required: false },
          promoted: { type: [String], required: false },
          deprecated: { type: [String], required: false },
          repriced: { type: [String], required: false },
          flagged: { type: [String], required: false },
        },
        { _id: false }
      ),
      required: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// TTL on startedAt: run reports are observability, not the catalog of record
// (ModelCatalog rows are never expired). Single-field indexes read in both
// directions, so this also serves the newest-run sorts below.
ModelDiscoveryRunSchema.index({ startedAt: 1 }, { expireAfterSeconds: RUN_RETENTION_SECONDS });

export type IModelDiscoveryRunModel = Model<IModelDiscoveryRunDocument>;

export class ModelDiscoveryRunRepository
  extends BaseRepository<IModelDiscoveryRunDocument>
  implements IModelDiscoveryRunRepository
{
  constructor(model: IModelDiscoveryRunModel) {
    super(model);
  }

  async latestRun(host?: DiscoveryRunHost): Promise<IModelDiscoveryRun | null> {
    const doc = await this.model
      .findOne(host ? { host } : {})
      .sort({ startedAt: -1 })
      .lean();
    return doc as IModelDiscoveryRun | null;
  }

  async lastSuccessfulRun(host?: DiscoveryRunHost): Promise<IModelDiscoveryRun | null> {
    const doc = await this.model
      .findOne(host ? { host, status: 'ok' } : { status: 'ok' })
      .sort({ startedAt: -1 })
      .lean();
    return doc as IModelDiscoveryRun | null;
  }
}

export const ModelDiscoveryRun =
  (mongoose.models['ModelDiscoveryRun'] as unknown as IModelDiscoveryRunModel) ??
  model<IModelDiscoveryRunDocument>('ModelDiscoveryRun', ModelDiscoveryRunSchema);
export const modelDiscoveryRunRepository = new ModelDiscoveryRunRepository(ModelDiscoveryRun);
