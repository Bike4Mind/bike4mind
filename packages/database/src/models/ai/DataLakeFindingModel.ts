import mongoose, { Model, Schema } from 'mongoose';
import type {
  IDataLakeFindingDocument,
  IDataLakeFindingRepository,
  LakeFindingDetector,
  LakeFindingKey,
  ListLakeFindingsOptions,
  RecordLakeFindingInput,
  ResolveLakeFindingInput,
} from '@bike4mind/common';
import { INCONSISTENCY_KINDS, LAKE_FINDING_DETECTORS, LAKE_FINDING_STATUSES } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

const ModelName = 'DataLakeFinding';

interface IDataLakeFindingModel extends Model<IDataLakeFindingDocument> {}

/**
 * One row per machine-detected corpus problem in one lake (#3039). Replaces the single overwritable
 * report blob on the lake document, which gave findings no identity and so no way to be triaged,
 * assigned or resolved. See DataLakeFindingTypes.ts for the field-by-field contract, and for why
 * nothing here may gate ingest.
 */
const DataLakeFindingSchema = new Schema<IDataLakeFindingDocument>(
  {
    lakeId: { type: String, required: true },
    kind: { type: String, enum: INCONSISTENCY_KINDS, required: true },
    subject: { type: String, required: true },
    detector: { type: String, enum: LAKE_FINDING_DETECTORS, required: true },
    // Mirrors LakeFindingSource field for field. Mongoose strict mode drops anything declared on
    // one side only, so a field added there must be added here in the same commit or it is
    // silently not persisted.
    sources: {
      type: [
        new Schema(
          {
            fabFileId: { type: String, required: true },
            fileName: { type: String, default: null },
            excerpt: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    documentCount: { type: Number, required: true },
    status: { type: String, enum: LAKE_FINDING_STATUSES, required: true, default: 'open' },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    assigneeUserId: { type: String, default: null },
    resolution: { type: String, default: null },
    resolvedByUserId: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// The finding's identity. `unique` here is a data constraint, not a query hint: it IS the "one row
// per problem" invariant this collection exists to deliver, and `recordDetected` is a single upsert
// against exactly this key rather than a read followed by a write, so the index is what makes two
// concurrent detection runs over one lake converge on one row instead of two.
//
// Unconditionally unique, unlike the proposal queue's pending-only partial index. A terminal
// proposal must free its key so a changed source can be re-proposed; a terminal finding must NOT,
// because re-detecting a resolved problem is the same problem recurring, not a new one. Keeping the
// key occupied is what lets `lastSeenAt` move past `resolvedAt` and make that recurrence visible.
DataLakeFindingSchema.index({ lakeId: 1, detector: 1, kind: 1, subject: 1 }, { unique: true });
// The review queue. Serves the common narrowing - one lake, by status, then kind - and supplies the
// sort for it. A listing that skips status (kind-only, detector-only, unfiltered) still seeks on the
// lakeId prefix but sorts in memory, which is bounded by the page limit the list route always sends.
DataLakeFindingSchema.index({ lakeId: 1, status: 1, kind: 1, lastSeenAt: -1 });
// The purge sweeps' only access path, and the only index here not keyed on a lake: a purge destroys
// a document globally, so `deleteForPurgedDocument`/`deleteForPurgedDocuments` query across every
// lake at once and have no lake prefix to seek on. The batched form's `$in` seeks this same index
// once per chunk. Multikey over `sources` (bounded at LAKE_FINDING_SOURCE_MAX entries per row).
// Same shape, for the same lookup, as PublishedArtifactSchema's `source.fabFileId` index.
DataLakeFindingSchema.index({ 'sources.fabFileId': 1 });

export const DataLakeFindingModel: IDataLakeFindingModel =
  (mongoose.models[ModelName] as IDataLakeFindingModel) ||
  mongoose.model<IDataLakeFindingDocument, IDataLakeFindingModel>(ModelName, DataLakeFindingSchema);

class DataLakeFindingRepository extends BaseRepository<IDataLakeFindingDocument> implements IDataLakeFindingRepository {
  constructor(private findingModel: mongoose.Model<IDataLakeFindingDocument>) {
    super(findingModel);
  }

  async recordDetected(input: RecordLakeFindingInput): Promise<IDataLakeFindingDocument> {
    const { lakeId, kind, subject, detector, sources, documentCount, seenAt } = input;
    // The four key fields are equality terms in the filter, so an insert derives them from it. They
    // are deliberately not repeated in $setOnInsert, where they would be a second place to drift.
    const key = { lakeId, detector, kind, subject };

    const upsert = () =>
      this.findingModel.findOneAndUpdate(
        key,
        {
          // Observation only. Status, assignee and resolution are absent on purpose: a re-detection
          // must not overwrite a curator's decision, and must not reopen what they closed.
          $set: { sources, documentCount },
          // `$max`, not `$set`: two runs can land out of order (a retried queue message, a slow run
          // finishing after a later one), and a plain $set would drag `lastSeenAt` BACKWARDS. That
          // is not cosmetic - it falsifies the two things this field is read for: the
          // `lastSeenAt > resolvedAt` recurrence signal documented on the interface, and the
          // `lastSeenAt: -1` review-queue sort. It can also invert `firstSeenAt > lastSeenAt`.
          // On insert $max simply sets the field, so the created row still reads seenAt.
          //
          // `sources`/`documentCount` stay a plain $set, deliberately: an out-of-order run then
          // leaves an older-but-still-real observation of the SAME problem, which is a stale quote
          // rather than a false timestamp. Conditioning them would mean adding a `lastSeenAt` term
          // to the filter, and a filter that misses turns this upsert into an insert against the
          // unique key - a guaranteed 11000 and a pointless retry, which is strictly worse.
          $max: { lastSeenAt: seenAt },
          $setOnInsert: { firstSeenAt: seenAt, status: 'open' },
        },
        { upsert: true, new: true }
      );

    const doc = await upsert().catch(error => {
      // Two upserts racing the same new key: both miss on the find, both attempt the insert, and
      // the loser gets 11000. The winner's row is the row this caller wanted, so retrying once
      // finds it and takes the update path. A bare code check is unambiguous here - the identity
      // index is this collection's only unique index other than `_id`.
      if ((error as { code?: number }).code !== 11000) throw error;
      return upsert();
    });

    // `new: true` with `upsert: true` always returns a document; this narrows the type rather than
    // hiding a case.
    if (!doc) throw new Error(`Failed to record finding for lake ${lakeId}`);
    return doc.toJSON() as IDataLakeFindingDocument;
  }

  async listByLake(lakeId: string, options?: ListLakeFindingsOptions): Promise<IDataLakeFindingDocument[]> {
    const query = this.findingModel
      .find({
        lakeId,
        ...(options?.status ? { status: options.status } : {}),
        ...(options?.kind ? { kind: options.kind } : {}),
        ...(options?.detector ? { detector: options.detector } : {}),
      })
      .sort({ lastSeenAt: -1 });
    if (options?.limit) query.limit(options.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as IDataLakeFindingDocument);
  }

  async listDismissedKeys(lakeId: string, detector: LakeFindingDetector): Promise<LakeFindingKey[]> {
    // Projected to the two key halves and lean, because this is read on every detection run to
    // filter that run's output: hydrating the rows would pull each one's `sources` excerpts across
    // purely to throw them away. Seeks the review-queue index on its `lakeId, status` prefix.
    const rows = await this.findingModel
      .find({ lakeId, status: 'dismissed', detector }, { kind: 1, subject: 1, _id: 0 })
      .lean();
    return rows.map(({ kind, subject }) => ({ kind, subject }));
  }

  async resolveFinding(
    lakeId: string,
    id: string,
    input: ResolveLakeFindingInput
  ): Promise<IDataLakeFindingDocument | null> {
    const { status, resolvedByUserId, resolvedAt, resolution } = input;
    // `status: 'open'` in the FILTER is the double-resolve guard: the second writer of a race
    // matches nothing and gets null. Never split into a read then a write.
    //
    // `lakeId` is in the filter for a different reason: it keeps belongs-to-lake a property of the
    // WRITE rather than a rule the caller is trusted to have checked. A route that forgot the
    // check could otherwise rule on any finding id in the database.
    const doc = await this.findingModel.findOneAndUpdate(
      { _id: id, lakeId, status: 'open' },
      { $set: { status, resolvedByUserId, resolvedAt, resolution: resolution ?? null } },
      { new: true }
    );
    return (doc?.toJSON() as IDataLakeFindingDocument) ?? null;
  }

  async assignFinding(
    lakeId: string,
    id: string,
    assigneeUserId: string | null
  ): Promise<IDataLakeFindingDocument | null> {
    const doc = await this.findingModel.findOneAndUpdate(
      { _id: id, lakeId },
      { $set: { assigneeUserId } },
      { new: true }
    );
    return (doc?.toJSON() as IDataLakeFindingDocument) ?? null;
  }

  async deleteForLake(lakeId: string): Promise<number> {
    const res = await this.findingModel.deleteMany({ lakeId });
    return res.deletedCount ?? 0;
  }

  async deleteForPurgedDocument(fabFileId: string): Promise<number> {
    // A single dotted condition over the `sources` array, so this needs no $elemMatch: the
    // cross-element matching hazard only arises once two conditions have to hold on the SAME
    // element. Deliberately not lake-scoped - see the interface for why the blast radius is global.
    // That is also why it carries its own index: with no lakeId to seek on, the alternative is a
    // scan of the WHOLE collection (every lake's findings, not one lake's) on a path that runs
    // inside the caller's purge request.
    const res = await this.findingModel.deleteMany({ 'sources.fabFileId': fabFileId });
    return res.deletedCount ?? 0;
  }

  async deleteForPurgedDocuments(fabFileIds: string[]): Promise<number> {
    // Guarded: `$in: []` matches nothing, but issuing the round trip to learn that is the cost this
    // method exists to avoid.
    if (fabFileIds.length === 0) return 0;
    // Same single dotted condition as the one-id form, so the same multikey index serves it and the
    // same "no $elemMatch needed" reasoning holds - one condition, no cross-element hazard.
    const res = await this.findingModel.deleteMany({ 'sources.fabFileId': { $in: fabFileIds } });
    return res.deletedCount ?? 0;
  }
}

export const dataLakeFindingRepository = new DataLakeFindingRepository(DataLakeFindingModel);
