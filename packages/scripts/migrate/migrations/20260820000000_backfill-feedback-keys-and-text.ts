import { FeedbackModel, FeedbackTextModel, Quest, Session } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Backfill for #1864: move each feedback record's free text into the TTL'd `FeedbackText` sibling,
 * and derive the structured foreign keys (`sessionId`, `questId`, `organizationId`, `subject`) for
 * rows written before those fields existed. Indexes are built LAST, after the writes.
 *
 * WHY THIS IS A CURSOR AND NOT THE `updateMany` + PIPELINE-`$set` ARM. That arm is the right default
 * for a self-contained field derivation, but it cannot express this one: a historical `questId` is
 * only trustworthy if it belongs to the record's own `userId`, and establishing that means reading
 * the quest, then the quest's session, then comparing owners - two collections the pipeline would
 * have to `$lookup` into per document just to decide whether one field may be written. Iterating in
 * bounded batches is both clearer and cheaper here.
 *
 * A useful side effect: because every write is a plain `$set` computed in JS rather than a pipeline
 * expression, this migration needs no DocumentDB fallback branch - the operations it uses behave
 * identically there. That is why the `isDocumentDBConnection` split other migrations carry is
 * deliberately absent.
 *
 * OWNERSHIP RULE - MUST STAY IN SYNC with `deriveFeedbackKeys` (apps/client/server/utils). Both
 * resolve ownership through the SESSION, never through the quest: `Quest` has no top-level owner
 * field, and its nested `promptMeta.session.userId` is derived data written by the same turn that
 * produced the claim, so trusting it would be circular. A quest whose session belongs to someone
 * else contributes NO keys - not even the sessionId.
 *
 * Idempotent throughout: the text move skips rows that already have a text document, and the key
 * derivation only writes fields that are still missing. Safe to re-run after a partial failure.
 */

const BATCH = 500;

interface FeedbackRow {
  _id: unknown;
  userId?: string;
  content?: string;
  subject?: string;
  questId?: string;
  sessionId?: string;
  organizationId?: unknown;
  promptMeta?: { questId?: string; session?: { id?: string; organizationId?: string } };
}

/** Session ids the given user owns, resolved once per (user, session) pair encountered. */
async function ownsSession(sessionId: string, userId: string, cache: Map<string, string | null>): Promise<boolean> {
  const key = sessionId;
  if (!cache.has(key)) {
    try {
      const s = await Session.findById(sessionId).select({ userId: 1 }).lean();
      cache.set(key, s ? String((s as { userId?: string }).userId) : null);
    } catch {
      cache.set(key, null);
    }
  }
  const owner = cache.get(key);
  return !!owner && owner === String(userId);
}

const migration: MigrationFile = {
  id: 20260820000000,
  name: 'backfill feedback keys and split free text',

  up: async () => {
    // ---- Phase 1: move free text into its own expiring document -----------------------------
    // Rows whose text is still on the parent. Each becomes one FeedbackText document; the parent's
    // legacy `content` is left in place so a half-finished run cannot lose prose - the read-join
    // prefers the sibling and falls back to the field, so both states render correctly.
    let movedText = 0;
    let skippedText = 0;
    const textCursor = FeedbackModel.find({ content: { $exists: true, $ne: '' } })
      .select({ content: 1 })
      .lean()
      .cursor();

    for await (const row of textCursor as unknown as AsyncIterable<FeedbackRow>) {
      const feedbackId = String(row._id);
      const existing = await FeedbackTextModel.exists({ feedbackId });
      if (existing) {
        skippedText++;
        continue;
      }
      try {
        await FeedbackTextModel.create({ feedbackId, content: row.content });
        movedText++;
      } catch {
        // A unique-key race with a concurrent submission is benign: the text is already there.
        skippedText++;
      }
    }
    console.log(`[feedback-backfill] text documents created: ${movedText}, already present: ${skippedText}`);

    // ---- Phase 2: derive the structured keys ------------------------------------------------
    // Cheap tail first: every row that predates the field gets the product default, so the
    // required `subject` is never absent even for records with no promptMeta at all.
    const defaulted = await FeedbackModel.updateMany({ subject: { $exists: false } }, { $set: { subject: 'product' } });
    console.log(`[feedback-backfill] subject defaulted to 'product' on ${defaulted.modifiedCount} rows`);

    let linkedTurn = 0;
    let linkedSession = 0;
    let rejected = 0;
    const sessionOwner = new Map<string, string | null>();

    const keyCursor = FeedbackModel.find({
      questId: { $exists: false },
      'promptMeta.questId': { $exists: true },
    })
      .select({ userId: 1, promptMeta: 1 })
      .lean()
      .batchSize(BATCH)
      .cursor();

    for await (const row of keyCursor as unknown as AsyncIterable<FeedbackRow>) {
      const claimedQuestId = row.promptMeta?.questId;
      const userId = row.userId;
      if (!claimedQuestId || !userId) continue;

      let questSessionId: string | undefined;
      try {
        const quest = await Quest.findById(claimedQuestId).select({ sessionId: 1 }).lean();
        questSessionId = (quest as { sessionId?: string } | null)?.sessionId;
      } catch {
        questSessionId = undefined;
      }

      if (questSessionId && (await ownsSession(questSessionId, userId, sessionOwner))) {
        await FeedbackModel.updateOne(
          { _id: row._id },
          { $set: { questId: claimedQuestId, sessionId: questSessionId, subject: 'turn' } }
        );
        linkedTurn++;
        continue;
      }

      // The quest did not resolve, or resolved to someone else's conversation. Fall back to the
      // claimed session only if THAT is owned; otherwise the row keeps product scope and no keys.
      const claimedSessionId = row.promptMeta?.session?.id;
      if (claimedSessionId && (await ownsSession(claimedSessionId, userId, sessionOwner))) {
        await FeedbackModel.updateOne({ _id: row._id }, { $set: { sessionId: claimedSessionId, subject: 'session' } });
        linkedSession++;
      } else {
        rejected++;
      }
    }
    console.log(
      `[feedback-backfill] turn-linked: ${linkedTurn}, session-linked: ${linkedSession}, unverifiable: ${rejected}`
    );

    // NOTE: `organizationId` is deliberately NOT backfilled from `promptMeta.session.organizationId`.
    // That value is a String written by the turn itself, while this field is an authorization-grade
    // ObjectId ref - and the whole point of #1864 is that these keys are server-derived, not adopted
    // from a client-supplied blob. Historical rows keep the free-text `organization` name for
    // display; org-scoped reads apply from the point the key started being derived on write.

    // ---- Phase 3: indexes, after the writes -------------------------------------------------
    await FeedbackModel.createIndexes();
    await FeedbackTextModel.createIndexes();
    console.log('[feedback-backfill] indexes ensured on feedbacks and feedbacktexts');
  },

  down: async () => {
    // Not reversible in a useful sense. The derived keys are additive and the text documents are a
    // copy of prose still present on the parent, so there is nothing whose removal restores value -
    // and dropping either would destroy the only structured signal a rollup can count. Indexes are
    // additive too; removal, if ever wanted, is a deliberate forward migration.
  },
};

export default migration;
