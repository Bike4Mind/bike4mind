import { mongoose, FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { FEEDBACK_CONTENT_RETENTION_DAYS } from '@bike4mind/common';
import { type MigrationFile } from './index';

/**
 * Migration: backfill Feedback's new indexed foreign keys, split existing free text into the
 * TTL'd FeedbackText sibling, then build both models' declared indexes.
 *
 * Raw driver throughout Phases A-C (never the FeedbackModel/FeedbackTextModel schema classes) -
 * migrations are a point-in-time record and must not silently reshape themselves as the live
 * schema evolves after this file merges. Collection names below were confirmed empirically
 * against a real mongod, not assumed from the model name: Quest -> `quests`, but Session's model
 * name is `SessionModel`, which Mongoose pluralizes to `sessionmodels`, not `sessions` - no other
 * migration in this repo references either collection raw, so there was no existing precedent to
 * copy and getting it wrong here would have silently queried an empty collection.
 *
 * Ownership validation is a two-hop check because Quest carries no `userId` of its own -
 * ownership lives on the Session a quest's `sessionId` points at (same rule the create handler's
 * feedbackContext.ts applies). A questId/sessionId that fails to validate is SKIPPED AND LOGGED,
 * never null-written and never thrown: an unverifiable historical pointer must not become an
 * authorization key, but one bad row must not abort the whole run.
 *
 * organizationId is never sourced from `promptMeta.session.organizationId` - that field is a
 * String on the Quest side while the new field is an ObjectId, and an untyped comparison between
 * the two silently matches zero documents rather than throwing (see the regression test). It is
 * looked up from `users.organizationId` for the document's own `userId` instead, matching the
 * create handler's server-derived rule.
 *
 * bulkWrite (not an aggregation-pipeline update) for the validated backfill: a pipeline update
 * cannot `$lookup`, so the ownership hop has to happen in this script, in JS, before the write -
 * there is no DocumentDB-compatibility choice to make here, unlike Phase C's plain $set/$unset,
 * which is supported identically on both engines with no pipeline form involved.
 */

const BATCH_SIZE = 200;
const GRACE_DAYS = 30;

interface LegacyFeedbackDoc {
  _id: mongoose.Types.ObjectId;
  userId: string;
  createdAt?: Date;
  content?: string;
  promptMeta?: {
    questId?: string;
    session?: { id?: string; organizationId?: string };
  };
}

interface RawSessionDoc {
  userId?: string;
  users?: Array<{ userId?: string }>;
}

function isValidObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && mongoose.isValidObjectId(value);
}

const migration: MigrationFile = {
  id: 20260820000000,
  name: 'feedback derived keys and text split',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const feedbacks = db.collection<LegacyFeedbackDoc>('feedbacks');
    const feedbackTexts = db.collection('feedbacktexts');
    const quests = db.collection('quests');
    const sessions = db.collection<RawSessionDoc>('sessionmodels');
    const users = db.collection('users');

    const migrationStart = new Date();
    const organizationIdByUserId = new Map<string, mongoose.Types.ObjectId | null>();

    async function resolveOrganizationId(userId: string): Promise<mongoose.Types.ObjectId | null> {
      if (organizationIdByUserId.has(userId)) return organizationIdByUserId.get(userId) ?? null;
      const user = isValidObjectIdString(userId)
        ? await users.findOne({ _id: new mongoose.Types.ObjectId(userId) }, { projection: { organizationId: 1 } })
        : null;
      const organizationId = (user?.organizationId as mongoose.Types.ObjectId | undefined) ?? null;
      organizationIdByUserId.set(userId, organizationId);
      return organizationId;
    }

    // Mirrors apps/client/server/utils/sessionOwnership.ts's isSessionOwnedByUser - a migration
    // cannot import app-server code (must stay a self-contained, raw-driver point-in-time
    // record), but the OWNERSHIP RULE itself must still match the live handler's, including the
    // shared-session branch: a quest whose session was shared with (not owned by) this
    // document's userId is exactly as legitimate a backfill target as one directly owned.
    function isOwnedByRawSession(session: RawSessionDoc | null, userId: string): boolean {
      if (!session) return false;
      return session.userId === userId || (session.users?.some(share => share.userId === userId) ?? false);
    }

    // Two-hop ownership check: Quest has no userId of its own, so a claimed questId is only
    // trustworthy if the SESSION it points at belongs to (or is shared with) this document's own
    // userId.
    async function resolveKeysForDoc(
      doc: LegacyFeedbackDoc
    ): Promise<{ questId?: string; sessionId?: string; skippedReason?: string }> {
      const candidateQuestId = doc.promptMeta?.questId;
      if (candidateQuestId) {
        if (!isValidObjectIdString(candidateQuestId)) {
          return { skippedReason: `questId not a valid ObjectId (${candidateQuestId})` };
        }
        const quest = await quests.findOne(
          { _id: new mongoose.Types.ObjectId(candidateQuestId) },
          { projection: { sessionId: 1 } }
        );
        if (!quest) return { skippedReason: 'questId does not resolve to an existing quest' };
        const questSessionId = quest.sessionId as string | undefined;
        if (questSessionId && isValidObjectIdString(questSessionId)) {
          const session = await sessions.findOne(
            { _id: new mongoose.Types.ObjectId(questSessionId) },
            { projection: { userId: 1, users: 1 } }
          );
          if (isOwnedByRawSession(session, doc.userId)) {
            return { questId: candidateQuestId, sessionId: questSessionId };
          }
        }
        return { skippedReason: "quest session does not belong to this document's userId" };
      }

      const candidateSessionId = doc.promptMeta?.session?.id;
      if (candidateSessionId) {
        if (!isValidObjectIdString(candidateSessionId)) {
          return { skippedReason: `sessionId not a valid ObjectId (${candidateSessionId})` };
        }
        const session = await sessions.findOne(
          { _id: new mongoose.Types.ObjectId(candidateSessionId) },
          { projection: { userId: 1, users: 1 } }
        );
        if (isOwnedByRawSession(session, doc.userId)) {
          return { sessionId: candidateSessionId };
        }
        return { skippedReason: "session does not belong to this document's userId" };
      }

      return {};
    }

    // Phase A: validated FK backfill. Self-consuming filter - a migrated doc always gets a
    // subject (even 'product' with no keys), so it drops out of this filter and a re-run is a
    // no-op / safely resumable.
    let processed = 0;
    let questIdsWritten = 0;
    let sessionIdsWritten = 0;
    let skipped = 0;
    const skippedSample: string[] = [];

    while (true) {
      const docs = await feedbacks
        .find({ subject: { $exists: false } }, { projection: { userId: 1, promptMeta: 1, createdAt: 1, content: 1 } })
        .limit(BATCH_SIZE)
        .toArray();
      if (docs.length === 0) break;

      // Each doc's resolution is independent (resolveOrganizationId is memoized in the Map
      // above, so concurrent calls for the same userId just race on a cache fill, not a
      // correctness issue) - run the batch concurrently instead of one doc at a time.
      const resolved = await Promise.all(
        docs.map(async doc => {
          const [{ questId, sessionId, skippedReason }, organizationId] = await Promise.all([
            resolveKeysForDoc(doc),
            resolveOrganizationId(doc.userId),
          ]);
          return { doc, questId, sessionId, skippedReason, organizationId };
        })
      );

      const ops = [];
      for (const { doc, questId, sessionId, skippedReason, organizationId } of resolved) {
        const subject = questId ? 'turn' : sessionId ? 'session' : 'product';

        if (skippedReason) {
          skipped++;
          if (skippedSample.length < 20) skippedSample.push(`${doc._id.toString()}: ${skippedReason}`);
        } else {
          if (questId) questIdsWritten++;
          if (sessionId) sessionIdsWritten++;
        }

        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: { $set: { subject, organizationId, ...(questId && { questId }), ...(sessionId && { sessionId }) } },
          },
        });
      }

      const result = await feedbacks.bulkWrite(ops, { ordered: false });
      processed += docs.length;
      console.log(`[feedback-derived-keys] processed ${processed} (modified ${result.modifiedCount ?? 0})`);

      if ((result.modifiedCount ?? 0) === 0) {
        console.warn(`[feedback-derived-keys] stopping early: ${docs.length} docs matched but none modified`);
        break;
      }
    }

    console.log(
      `[feedback-derived-keys] backfilled subject on ${processed} docs ` +
        `(questId: ${questIdsWritten}, sessionId: ${sessionIdsWritten}, skipped: ${skipped})`
    );
    if (skippedSample.length > 0) {
      console.log(`[feedback-derived-keys] sample of skipped docs: ${skippedSample.join('; ')}`);
    }

    // Phase B: copy non-empty content into the TTL'd sibling. Historical expiresAt uses a grace
    // floor (migration start + 30 days) rather than the literal createdAt + 90d, so this backfill
    // does not double as an unannounced bulk deletion for reports already older than 90 days -
    // the floor gives operators a real window before the TTL first sweeps anything.
    let textsCopied = 0;
    const confirmedIds: mongoose.Types.ObjectId[] = [];

    const contentCursor = feedbacks.find(
      { content: { $exists: true, $type: 'string', $ne: '' } },
      { projection: { _id: 1, content: 1, createdAt: 1 } }
    );
    for await (const doc of contentCursor) {
      const literalExpiry = new Date(
        (doc.createdAt ?? migrationStart).getTime() + FEEDBACK_CONTENT_RETENTION_DAYS * 24 * 60 * 60 * 1000
      );
      const graceFloor = new Date(migrationStart.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
      const expiresAt = literalExpiry.getTime() > graceFloor.getTime() ? literalExpiry : graceFloor;

      const result = await feedbackTexts.updateOne(
        { _id: doc._id },
        {
          $setOnInsert: {
            content: doc.content,
            contentTruncated: false,
            expiresAt,
            createdAt: doc.createdAt ?? migrationStart,
          },
        },
        { upsert: true }
      );
      if (result.upsertedCount > 0 || result.matchedCount > 0) {
        textsCopied++;
        confirmedIds.push(doc._id);
      }
    }
    console.log(`[feedback-derived-keys] copied ${textsCopied} content rows into feedbacktexts`);

    // Phase C: unset the permanent copy, only for confirmed sibling writes. Plain $set/$unset -
    // no aggregation pipeline, no DocumentDB compatibility concern.
    if (confirmedIds.length > 0) {
      const unsetResult = await feedbacks.updateMany(
        { _id: { $in: confirmedIds } },
        { $unset: { content: '' }, $set: { contentStored: true } }
      );
      console.log(
        `[feedback-derived-keys] unset content on ${unsetResult.modifiedCount ?? 0} docs (contentStored: true)`
      );
    }
    // Every doc that reached Phase A but never had content still needs contentStored:false so
    // the field is never left `undefined` on a document the schema declares it required on.
    await feedbacks.updateMany({ contentStored: { $exists: false } }, { $set: { contentStored: false } });

    // Phase D: indexes last, so nothing can be swept between the text copy and verification.
    // Deploy-order note: autoIndex is enabled globally, so the first application process to
    // touch these models after deploy builds every declared index regardless of whether this
    // migration has run - this ordering protects the MIGRATION RUN, not the deploy. The Phase B
    // grace floor is what actually makes an index build racing ahead of this script safe.
    await FeedbackModel.createIndexes();
    await FeedbackTextModel.createIndexes();
    console.log('[feedback-derived-keys] indexes built on Feedback and FeedbackText');
  },

  down: async () => {
    // No rollback: indexes are additive, and moving FeedbackText's content back onto the
    // permanent Feedback document would undo the retention control this migration exists to add.
    console.log('[feedback-derived-keys] rollback: no-op; retention split is not reversible.');
  },
};

export default migration;
