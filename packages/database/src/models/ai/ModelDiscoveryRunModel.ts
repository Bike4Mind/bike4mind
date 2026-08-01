import mongoose, { Model, Schema, model } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import {
  DISCOVERY_RUN_HOSTS,
  DISCOVERY_RUN_MODES,
  DISCOVERY_RUN_STATUSES,
  DISCOVERY_RUN_TRIGGERS,
  DiscoveryRunHost,
  IModelDiscoveryRun,
  IModelDiscoveryRunDocument,
  IModelDiscoveryRunRepository,
} from '@bike4mind/common';

/** 90 days: long enough to answer "when did this model change and why". */
const RUN_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** Per-MTok, the readable unit; the price row a flag declined to write is per token. */
const PerMTokRatesSchema = new Schema(
  { inputPerMTok: { type: Number, required: true }, outputPerMTok: { type: Number, required: true } },
  { _id: false }
);

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
    // What the run was allowed to do, as it ran: a 'report' run plans writes and
    // lands none by design, and the current modelDiscoveryMode setting cannot
    // stand in for it - it can change between the run and the read. Optional
    // because runs written before this field existed have none.
    mode: { type: String, required: false, enum: [...DISCOVERY_RUN_MODES] },
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
            // Mixed rather than a Map of Number: the run-over-run parser-shift
            // guard reads this back through a hydrated find(), where a Map would
            // arrive as a Map and a plain record arrives as itself.
            parserRows: { type: Schema.Types.Mixed, required: false },
            recordCount: { type: Number, required: false },
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
          // The operator overlaps `flagged` merges in with the price flags. Both
          // arrays are kept: `flagged` is what the status card counts.
          operatorConflicts: { type: [String], required: false },
          // Everything above is the PLAN, identically in both modes. These four
          // are what actually happened, and they are the only way a write-mode
          // run whose appends all failed reads differently from a clean one.
          plannedRows: { type: Number, required: false },
          appendedRows: { type: Number, required: false },
          plannedPriceRows: { type: Number, required: false },
          appendedPriceRows: { type: Number, required: false },
        },
        { _id: false }
      ),
      required: false,
    },
    passes: { type: Number, required: false },
    droppedRecords: {
      type: [
        new Schema(
          {
            source: { type: String, required: true },
            modelId: { type: String, required: true },
            reason: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    // The detail behind the counts in `changes`, and the reason a run document is
    // worth reading whole. Nothing here may become required: the collection holds
    // runs written before these fields existed. The service-owned enumerations
    // (`kind`, `reason`, `signal`, `blockedBy`) are stored as free strings so a
    // new value there cannot make an already-written run unreadable.
    //
    // Every path the zod shapes declare non-optional carries a `default` instead:
    // .lean() skips defaults, so a subdoc written without one would come back
    // undefined while IModelDiscoveryRun promises a value, and the report reads
    // these arrays without guarding.
    priceFlags: {
      type: [
        new Schema(
          {
            modelId: { type: String, required: true },
            kind: { type: String, required: true },
            proposed: { type: PerMTokRatesSchema, required: true },
            current: { type: PerMTokRatesSchema, required: false },
            sources: { type: [String], required: false, default: [] },
            // The sentence explaining the flag, which used to reach only the log.
            detail: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    priceRows: {
      type: [
        new Schema(
          {
            modelId: { type: String, required: true },
            unit: { type: String, required: true },
            inputPerMTok: { type: Number, required: true },
            outputPerMTok: { type: Number, required: true },
            effectiveFrom: { type: Date, required: true },
            sources: { type: [String], required: false, default: [] },
            note: { type: String, required: false, default: '' },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    priceOverrides: {
      type: [
        new Schema(
          {
            modelId: { type: String, required: true },
            source: { type: String, required: true },
            dissenting: { type: [String], required: false, default: [] },
            applied: { type: PerMTokRatesSchema, required: true },
            detail: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    priceSkips: {
      type: [
        new Schema(
          {
            modelId: { type: String, required: true },
            reason: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    lifecycleTransitions: {
      type: [
        new Schema(
          {
            modelId: { type: String, required: true },
            from: { type: String, required: false },
            to: { type: String, required: true },
            signal: { type: String, required: true },
            deprecationDate: { type: String, required: false },
            retirementDate: { type: String, required: false },
            replacedBy: { type: String, required: false },
            autoApplied: { type: Boolean, required: false, default: false },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    catalogDiff: {
      type: [
        new Schema(
          {
            modelId: { type: String, required: true },
            kind: { type: String, required: true },
            ownedGroups: { type: [String], required: false, default: [] },
            changedKeys: { type: [String], required: false, default: [] },
            // 'unknown' rather than '' so the report shows a word, not a blank cell.
            lifecycleStatus: { type: String, required: false, default: 'unknown' },
            promoted: { type: Boolean, required: false, default: false },
            blockedBy: { type: [String], required: false, default: [] },
            operatorOwned: { type: Boolean, required: false, default: false },
          },
          { _id: false }
        ),
      ],
      required: false,
    },
    // Written only when a detail array above was truncated, so an absent object
    // means "nothing was cut" rather than "totals unknown".
    detailTotals: {
      type: new Schema(
        {
          priceFlags: { type: Number, required: false },
          priceRows: { type: Number, required: false },
          priceOverrides: { type: Number, required: false },
          priceSkips: { type: Number, required: false },
          lifecycleTransitions: { type: Number, required: false },
          catalogDiff: { type: Number, required: false },
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

/**
 * The report bodies, left off the list. Twenty runs carrying six bounded detail
 * arrays each is megabytes on an endpoint the status card polls, and the list
 * shows counts; runById is what reads a run's detail.
 */
const RUN_LIST_PROJECTION = {
  priceFlags: 0,
  priceRows: 0,
  priceOverrides: 0,
  priceSkips: 0,
  lifecycleTransitions: 0,
  catalogDiff: 0,
  droppedRecords: 0,
  unmatchedIds: 0,
} as const;

/**
 * lean() skips the `id` virtual, and the admin run list is addressed by it: the
 * detail fetch is `?runId=`, so a run with no id is a run nobody can open.
 */
const withId = (doc: IModelDiscoveryRun & { _id?: unknown }): IModelDiscoveryRun => ({
  ...doc,
  id: String(doc._id),
});

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

  async recentRuns(limit: number, host?: DiscoveryRunHost): Promise<IModelDiscoveryRun[]> {
    const docs = await this.model
      .find(host ? { host } : {}, RUN_LIST_PROJECTION)
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean();
    return docs.map(doc => withId(doc as IModelDiscoveryRun & { _id?: unknown }));
  }

  async runById(id: string): Promise<IModelDiscoveryRun | null> {
    // An id out of a URL is whatever the caller typed; findById would throw a
    // CastError on it, and "no such run" is a 404 rather than a 500.
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.model.findById(id).lean();
    return doc ? withId(doc as IModelDiscoveryRun & { _id?: unknown }) : null;
  }
}

export const ModelDiscoveryRun =
  (mongoose.models['ModelDiscoveryRun'] as unknown as IModelDiscoveryRunModel) ??
  model<IModelDiscoveryRunDocument>('ModelDiscoveryRun', ModelDiscoveryRunSchema);
export const modelDiscoveryRunRepository = new ModelDiscoveryRunRepository(ModelDiscoveryRun);
