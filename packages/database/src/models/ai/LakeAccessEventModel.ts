import mongoose, { Model, Schema } from 'mongoose';
import type {
  ILakeAccessEventDocument,
  ILakeAccessEventRepository,
  ILakeAccessQueryTextDocument,
  LakeAccessPrincipalKind,
  RecordLakeAccessEventInput,
} from '@bike4mind/common';
import {
  LAKE_ACCESS_EVENT_MAX_IDS,
  LAKE_ACCESS_PRINCIPAL_KINDS,
  LAKE_ACCESS_QUERY_TEXT_MAX_CHARS,
  LAKE_ACCESS_SURFACES,
  lakeAccessExpiresAt,
  resolveLakeAccessAuditRetentionDays,
  resolveLakeAccessQueryTextRetentionDays,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { DataLakeModel } from './DataLakeModel';
import { LakeAccessQueryTextModel } from './LakeAccessQueryTextModel';

const ModelName = 'LakeAccessEvent';

/**
 * The audit trail a lake never had: one document per retrieval call, recording WHO read a lake
 * and WHEN - never the chunk text itself. See LakeAccessEventTypes.ts for the field-by-field
 * rationale.
 *
 * Deliberately does NOT copy MemoryLedgerEventModel's hash-chain (seq/hash/prevHash, unique chain
 * spine): a hash chain is incompatible with a TTL (the sweep deletes the tail and chain
 * verification would then fail by construction), and two identical retrieval calls are
 * legitimately two rows here, so there is no natural unique key to chain on.
 */
interface ILakeAccessEventModel extends Model<ILakeAccessEventDocument> {}

const LakeAccessEventSchema = new Schema<ILakeAccessEventDocument>(
  {
    principalKind: { type: String, enum: LAKE_ACCESS_PRINCIPAL_KINDS, required: true },
    principalId: { type: String, required: true },
    onBehalfOfUserId: { type: String },
    organizationId: { type: String },
    resolvedLakeIds: { type: [String], default: [] },
    returnedChunkIds: { type: [String], default: [] },
    returnedFileIds: { type: [String], default: [] },
    returnedChunkCount: { type: Number, required: true, min: 0 },
    identifiersTruncated: { type: Boolean, default: false },
    surface: { type: String, enum: LAKE_ACCESS_SURFACES, required: true },
    queryTextLogged: { type: Boolean, default: false },
    // Computed at write time from the floor-clamped retention; immutable so nothing downstream
    // can shorten the audit trail below the floor by mutating this field after the fact (the
    // floor guarantee in `record()` would otherwise be bypassable via a plain updateOne).
    expiresAt: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    versionKey: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

LakeAccessEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
LakeAccessEventSchema.index({ principalKind: 1, principalId: 1, createdAt: -1 });
// Multikey: "who read this lake?" - the core audit query.
LakeAccessEventSchema.index({ resolvedLakeIds: 1, createdAt: -1 });
LakeAccessEventSchema.index({ organizationId: 1, createdAt: -1 });

export const LakeAccessEventModel: ILakeAccessEventModel =
  (mongoose.models[ModelName] as ILakeAccessEventModel) ||
  mongoose.model<ILakeAccessEventDocument, ILakeAccessEventModel>(ModelName, LakeAccessEventSchema);

class LakeAccessEventRepository extends BaseRepository<ILakeAccessEventDocument> implements ILakeAccessEventRepository {
  constructor(private eventModel: mongoose.Model<ILakeAccessEventDocument>) {
    super(eventModel);
  }

  /**
   * Record one retrieval-call access event. The floor clamp and the query-text opt-in decision
   * are BOTH resolved inside this function, never trusted from the caller, so neither guarantee
   * can be bypassed by a caller that passes an unclamped `retentionDays` or an unverified opt-in
   * flag.
   */
  async record(input: RecordLakeAccessEventInput): Promise<ILakeAccessEventDocument> {
    const now = input.now ?? new Date();
    const auditDays = resolveLakeAccessAuditRetentionDays(input.retentionDays);
    const expiresAt = lakeAccessExpiresAt(now, auditDays);

    const chunkIds = input.chunkIds ?? [];
    const fileIds = input.fileIds ?? [];
    const returnedChunkCount = chunkIds.length;
    const identifiersTruncated =
      chunkIds.length > LAKE_ACCESS_EVENT_MAX_IDS || fileIds.length > LAKE_ACCESS_EVENT_MAX_IDS;

    // The query-text write happens BEFORE the event, keyed to a pre-generated id, so
    // `queryTextLogged` on the event always reflects the true OUTCOME of the attempt - never just
    // the intent. A swallowed failure on the best-effort text write must not leave the event
    // claiming text exists when it does not.
    const eventId = new mongoose.Types.ObjectId();
    const queryText = input.queryText?.trim();
    let queryTextLogged = false;
    if (queryText && (await this.everyLakeOptedIn(input.resolvedLakeIds))) {
      queryTextLogged = await this.tryWriteQueryText(eventId, queryText, auditDays, input.queryTextRetentionDays, now);
    }

    const created = await this.eventModel.create({
      _id: eventId,
      principalKind: input.principalKind,
      principalId: input.principalId,
      onBehalfOfUserId: input.onBehalfOfUserId,
      organizationId: input.organizationId,
      resolvedLakeIds: input.resolvedLakeIds,
      returnedChunkIds: chunkIds.slice(0, LAKE_ACCESS_EVENT_MAX_IDS),
      returnedFileIds: fileIds.slice(0, LAKE_ACCESS_EVENT_MAX_IDS),
      returnedChunkCount,
      identifiersTruncated,
      surface: input.surface,
      queryTextLogged,
      expiresAt,
    });

    return created.toJSON() as unknown as ILakeAccessEventDocument;
  }

  async listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeAccessEventDocument[]> {
    const query = this.eventModel.find({ resolvedLakeIds: lakeId }).sort({ createdAt: -1 });
    if (opts?.limit) query.limit(opts.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as unknown as ILakeAccessEventDocument);
  }

  async listByPrincipal(
    principalKind: LakeAccessPrincipalKind,
    principalId: string,
    opts?: { limit?: number }
  ): Promise<ILakeAccessEventDocument[]> {
    const query = this.eventModel.find({ principalKind, principalId }).sort({ createdAt: -1 });
    if (opts?.limit) query.limit(opts.limit);
    const docs = await query;
    return docs.map(d => d.toJSON() as unknown as ILakeAccessEventDocument);
  }

  /**
   * UNANIMITY, never vacuous: every id in `resolvedLakeIds` must resolve to a persisted lake with
   * `auditQueryTextEnabled === true`. An empty input, or one where every id gets filtered out as a
   * non-ObjectId registry slug (no backing document to consult), is NOT opted in - "all N of zero
   * considered ids agreed" would otherwise be vacuously true and log a query nobody consented to.
   */
  private async everyLakeOptedIn(resolvedLakeIds: string[]): Promise<boolean> {
    const uniqueIds = [...new Set(resolvedLakeIds)];
    const validIds = uniqueIds.filter(id => mongoose.isValidObjectId(id));
    if (validIds.length === 0 || validIds.length !== uniqueIds.length) return false;

    const optedInCount = await DataLakeModel.countDocuments({
      _id: { $in: validIds },
      auditQueryTextEnabled: true,
    });
    return optedInCount === validIds.length;
  }

  /**
   * Best-effort: writing the event itself is what matters for the compliance artifact, so a
   * failure here is logged and swallowed rather than thrown - never let a query-text write
   * failure block the retrieval it audits. Returns whether the write actually succeeded, so the
   * caller can set the event's `queryTextLogged` to the true outcome rather than the intent.
   */
  private async tryWriteQueryText(
    eventId: mongoose.Types.ObjectId,
    queryText: string,
    auditDays: number,
    queryTextRetentionDays: number | undefined,
    now: Date
  ): Promise<boolean> {
    try {
      const days = resolveLakeAccessQueryTextRetentionDays(queryTextRetentionDays, auditDays);
      const truncated = queryText.length > LAKE_ACCESS_QUERY_TEXT_MAX_CHARS;
      await LakeAccessQueryTextModel.create({
        _id: eventId,
        queryText: truncated ? queryText.slice(0, LAKE_ACCESS_QUERY_TEXT_MAX_CHARS) : queryText,
        queryTextTruncated: truncated,
        expiresAt: lakeAccessExpiresAt(now, days),
      } as Partial<ILakeAccessQueryTextDocument>);
      return true;
    } catch (err) {
      console.warn('[lakeAccessEvent] failed to write query-text sibling', err);
      return false;
    }
  }
}

export const lakeAccessEventRepository: ILakeAccessEventRepository = new LakeAccessEventRepository(
  LakeAccessEventModel
);
