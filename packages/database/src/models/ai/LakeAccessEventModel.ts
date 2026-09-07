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
  LAKE_ACCESS_IDENTIFIER_MAX_CHARS,
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
    // maxlength validates each ARRAY ELEMENT for a String-array path (Mongoose applies element
    // validators to every entry) - real ids are short, so this is a structural backstop against
    // a future caller mistakenly handing this model passage text instead of an identifier, not
    // just the naming-convention guard the corpus-leak test already covers.
    returnedChunkIds: { type: [{ type: String, maxlength: LAKE_ACCESS_IDENTIFIER_MAX_CHARS }], default: [] },
    returnedFileIds: { type: [{ type: String, maxlength: LAKE_ACCESS_IDENTIFIER_MAX_CHARS }], default: [] },
    // default: undefined, not omitted: Mongoose's own built-in default for an array-type path is
    // [], regardless of whether `default` is specified at all - the same auto-vivification trap
    // QuestModel.ts's subSchema convention exists to prevent, just without the nested-object shape
    // that trap description usually invokes. Without this override, every row would carry
    // scores: [] and "no similarity-search concept on this surface" would be indistinguishable
    // from "ran, found nothing" - see ILakeAccessEvent.scores's doc comment. record() enforces
    // index-alignment with returnedChunkIds itself rather than trusting the caller.
    scores: { type: [Number], default: undefined },
    returnedChunkCount: { type: Number, required: true, min: 0 },
    returnedFileCount: { type: Number, required: true, min: 0 },
    identifiersTruncated: { type: Boolean, default: false },
    // `default: undefined`, unlike identifiersTruncated above: absent is a THIRD state here, not a
    // synonym for false. A `default: false` would stamp every non-reporting surface's row as
    // "considered its whole candidate set" - see ILakeAccessEvent.candidateCapReached.
    candidateCapReached: { type: Boolean, required: false, default: undefined },
    surface: { type: String, enum: LAKE_ACCESS_SURFACES, required: true },
    queryTextLogged: { type: Boolean, default: false },
    // No enum: this is a diagnostic join key, not a value this schema's job is to validate - see
    // ILakeAccessEvent.questId's doc comment. Absent on quest-less HTTP surfaces and (until an
    // agent execution reaches the point of having a linked Quest id) some agent-mode rows.
    questId: { type: String },
    sessionId: { type: String },
    // Computed at write time from the floor-clamped retention. `immutable` blocks the ordinary
    // updateOne/updateMany/findOneAndUpdate paths (Mongoose strips immutable fields from a query
    // update's cast unless the caller explicitly passes `overwriteImmutable: true`) - it is a
    // backstop against an accidental mutation, NOT a guarantee against a caller that deliberately
    // opts out of it or reaches the collection via the raw driver. The repository below never
    // exposes update/delete, and the guard test in LakeAccessEventModel.test.ts is the real
    // enforcement that no OTHER file in this codebase tries either bypass.
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
// Multikey: "who read this lake?" - the core audit query. The `_id: -1` suffix is load-bearing,
// not decoration: listByLake sorts { createdAt: -1, _id: -1 } for a stable page window, and an
// index without `_id` cannot supply that order - the planner would drop the indexed sort and
// blocking-SORT the lake's whole 450-day retention window on every read.
LakeAccessEventSchema.index({ resolvedLakeIds: 1, createdAt: -1, _id: -1 });
LakeAccessEventSchema.index({ organizationId: 1, createdAt: -1 });
// Single-field, no createdAt companion (unlike the three above): rows per questId are bounded by
// the turn, at one row per content-returning tool call. That is single-digit in classic chat, but
// in AGENT mode one dispatch-time Quest spans a whole ReAct run, so a 25-iteration execution
// (the default maxIterations) searching each iteration lands ~25 rows under one questId - and
// more if a single iteration issues parallel tool calls. Still trivial to sort in memory, which is
// why the decision holds; contrast resolvedLakeIds/organizationId/(principalKind,principalId),
// which span thousands of rows over the 450-day retention window and genuinely need the companion.
// sparse: most rows have no questId (quest-less HTTP surfaces, pre-migration rows, an agent-mode
// row before its execution has a linked Quest id) - a sparse index indexes only the linked ones.
// Built via a migration, not relying on autoIndex's lazy cold-boot build - see the migration's
// own doc comment for why.
LakeAccessEventSchema.index({ questId: 1 }, { sparse: true });

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
    // The real wall clock, always - there is no caller-facing override. An injectable `now` on
    // the public input would let any caller (accidentally or not) backdate an event past its own
    // floor-clamped retention window, since the floor only bounds the DURATION (`auditDays`), not
    // the point it is measured from. Tests control time via `vi.useFakeTimers()` instead.
    const now = new Date();
    const auditDays = resolveLakeAccessAuditRetentionDays(input.retentionDays);
    const expiresAt = lakeAccessExpiresAt(now, auditDays);

    const chunkIds = input.chunkIds ?? [];
    const fileIds = input.fileIds ?? [];
    const returnedChunkCount = chunkIds.length;
    const returnedFileCount = fileIds.length;
    const identifiersTruncated =
      chunkIds.length > LAKE_ACCESS_EVENT_MAX_IDS || fileIds.length > LAKE_ACCESS_EVENT_MAX_IDS;
    // Never trust the caller's alignment: a scores array that doesn't match chunkIds 1:1 (before
    // truncation) would misattribute a score to the wrong chunk once both are sliced - so a
    // mismatch drops scores entirely rather than risk a silent wrong pairing. Sliced through the
    // SAME cap as returnedChunkIds, never independently.
    if (input.scores && input.scores.length !== chunkIds.length) {
      console.warn(
        `[lakeAccessEvent] scores.length (${input.scores.length}) !== chunkIds.length (${chunkIds.length}) - dropping scores`
      );
    }
    const scores =
      input.scores && input.scores.length === chunkIds.length
        ? input.scores.slice(0, LAKE_ACCESS_EVENT_MAX_IDS)
        : undefined;

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

    try {
      const created = await this.eventModel.create({
        _id: eventId,
        principalKind: input.principalKind,
        principalId: input.principalId,
        onBehalfOfUserId: input.onBehalfOfUserId,
        organizationId: input.organizationId,
        resolvedLakeIds: input.resolvedLakeIds,
        returnedChunkIds: chunkIds.slice(0, LAKE_ACCESS_EVENT_MAX_IDS),
        returnedFileIds: fileIds.slice(0, LAKE_ACCESS_EVENT_MAX_IDS),
        // `scores?.length`, not `scores` - an empty array is truthy, so a caller passing
        // `scores: []` would otherwise persist one. Note this COLLAPSES the absent-vs-empty
        // distinction the `default: undefined` above preserves, rather than protecting it: an
        // explicitly-empty array is stored as absent. That is sound only because the empty state
        // is unreachable - every scored writer skips the write on zero results (the semantic arm
        // returns `output: null` and never reaches here), and an empty `scores` alongside
        // `chunkIds: []` would carry nothing `returnedChunkCount: 0` does not. If a surface ever
        // records a genuine zero-result semantic search, revisit this rather than the default.
        ...(scores?.length ? { scores } : {}),
        returnedChunkCount,
        returnedFileCount,
        identifiersTruncated,
        // `typeof`, not truthiness: an explicit `false` is a real assertion (this surface
        // considered everything) and must not be silently dropped into the absent state.
        ...(typeof input.candidateCapReached === 'boolean' ? { candidateCapReached: input.candidateCapReached } : {}),
        surface: input.surface,
        queryTextLogged,
        // `|| undefined`, so an empty string is stored as absent rather than indexed: the questId
        // index is sparse, and `''` would occupy it as a row that looks linked and joins to
        // nothing. No caller produces `''` today - this keeps the field honest to this function's
        // own contract that nothing is trusted from the caller.
        questId: input.questId || undefined,
        sessionId: input.sessionId || undefined,
        expiresAt,
      });
      return created.toJSON() as unknown as ILakeAccessEventDocument;
    } catch (err) {
      // If the event itself fails to persist (a bad enum, a future schema change), a query-text
      // row already written under `eventId` would otherwise survive ORPHANED - unreachable by
      // listByLake/listByPrincipal and unattributable to any principal or lake, exactly the
      // "record of everyone's questions with no audit context" the two-collection split exists
      // to prevent. Best-effort cleanup; the original error is what the caller needs to see.
      if (queryTextLogged) {
        await LakeAccessQueryTextModel.deleteOne({ _id: eventId }).catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * NOT a complete picture of every read a lake was ever party to, in two different directions -
   * a UI presenting per-lake history needs to say so rather than implying this list is exhaustive:
   *
   * - Under-inclusive: an agent-scoped chat read (surface chat-kb-search-scoped, or
   *   chat-kb-retrieve/chat-kb-search under a kbScope) is authorized by the agent owner's curated
   *   file-id whitelist, not by lake membership, so it is recorded with resolvedLakeIds always
   *   empty and never matches this query - see the "never consults lake access" comments at those
   *   record call sites. Those events are still fully durable and visible via listByPrincipal.
   * - Noisy: `data-lake-public-browse` rows DO match this query (the browsed lakes are the
   *   result, so resolvedLakeIds is genuinely populated) but are catalog-metadata reads (name/
   *   description), not content reads - a caller presenting this as "who read this lake's
   *   content" should filter or label by `surface` rather than treat every match as equivalent.
   *
   * ORDER IS PART OF THE CONTRACT: newest first by `createdAt`, with `_id` descending as the
   * tie-break so same-millisecond events cannot reshuffle between reads. With `limit`, that makes
   * the result the most RECENT window rather than an arbitrary one, and the last element the
   * window's start - which `assembleLakeAccessView` publishes as `windowStartsAt` on a truncated
   * compliance export. Changing this sort silently turns that date wrong; the reads test pins it.
   */
  async listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeAccessEventDocument[]> {
    const query = this.eventModel.find({ resolvedLakeIds: lakeId }).sort({ createdAt: -1, _id: -1 });
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
      // Codepoint-safe: a plain .slice(0, N) counts UTF-16 code units, so it can split a
      // surrogate pair (an emoji, many non-Latin scripts) right at the cap boundary.
      const codepoints = Array.from(queryText);
      const truncated = codepoints.length > LAKE_ACCESS_QUERY_TEXT_MAX_CHARS;
      await LakeAccessQueryTextModel.create({
        _id: eventId,
        queryText: truncated ? codepoints.slice(0, LAKE_ACCESS_QUERY_TEXT_MAX_CHARS).join('') : queryText,
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
