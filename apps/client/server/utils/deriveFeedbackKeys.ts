import { Quest, Session } from '@bike4mind/database';
import type { FeedbackSubject } from '@bike4mind/common';

export interface DerivedFeedbackKeys {
  sessionId?: string;
  questId?: string;
  organizationId?: string;
  subject: FeedbackSubject;
}

interface DeriveInput {
  /** `promptMeta.questId` as the client SENT it - a claim to be verified, never a value to store. */
  claimedQuestId?: string;
  /** `promptMeta.session.id` as the client sent it. Same status: a claim. */
  claimedSessionId?: string;
  /** The authenticated caller. Undefined for an anonymous submission. */
  userId?: string;
  /** The caller's org, read from their own user record server-side. Never from the body. */
  organizationId?: string;
  logger?: { warn?: (msg: string, meta?: unknown) => void };
}

/**
 * Resolve the server-derived foreign keys for a feedback record (#1864).
 *
 * WHY THIS EXISTS: these keys become authorization keys the moment a scoped reader (#1866) filters
 * on them, so a client-supplied `questId` or `organizationId` would let a reporter attach their
 * record to someone else's turn - and then read it back through a filter that trusts the key. The
 * request body is treated as a set of CLAIMS: each one is re-read server-side and kept only if it
 * belongs to the caller.
 *
 * OWNERSHIP IS RESOLVED THROUGH THE SESSION, NOT THE QUEST. `Quest` has no top-level owner field -
 * its only `userId` lives inside `promptMeta.session`, which is itself derived data written by the
 * same turn that produced the claim, so trusting it would be circular. `Session.userId` is the real
 * ACL boundary and is indexed. A quest whose session belongs to someone else has BOTH keys dropped.
 *
 * A failed claim is dropped and logged, never fatal: feedback submission must not break because a
 * stale client sent a quest id from a deleted session. But the drop is logged loudly, because the
 * same signature is what a deliberate cross-user link attempt looks like.
 *
 * NOTE: the backfill migration for pre-#1864 rows must mirror this same ownership rule. It runs as
 * a bulk aggregation rather than calling this helper, so the two have to be kept in step by hand.
 */
export async function deriveFeedbackKeys({
  claimedQuestId,
  claimedSessionId,
  userId,
  organizationId,
  logger,
}: DeriveInput): Promise<DerivedFeedbackKeys> {
  // Anonymous submissions get no turn linkage at all: with no authenticated identity there is
  // nothing to validate a claim against, and an unvalidated key is worse than an absent one.
  if (!userId) return { subject: 'product' };

  const base = { organizationId };

  const ownsSession = async (sessionId: string): Promise<boolean> => {
    try {
      const session = await Session.findById(sessionId).select({ userId: 1 }).lean();
      return !!session && String((session as { userId?: string }).userId) === String(userId);
    } catch {
      // A malformed id throws a CastError here rather than returning null. Treat it as "not mine".
      return false;
    }
  };

  if (claimedQuestId) {
    let questSessionId: string | undefined;
    try {
      const quest = await Quest.findById(claimedQuestId).select({ sessionId: 1 }).lean();
      questSessionId = (quest as { sessionId?: string } | null)?.sessionId;
    } catch {
      questSessionId = undefined;
    }

    if (!questSessionId) {
      logger?.warn?.('[feedback] claimed questId did not resolve; storing no turn linkage', {
        claimedQuestId,
      });
    } else if (await ownsSession(questSessionId)) {
      return { ...base, sessionId: questSessionId, questId: claimedQuestId, subject: 'turn' };
    } else {
      // Both keys dropped on purpose - keeping the sessionId would still attach this record to a
      // conversation the reporter does not own.
      logger?.warn?.("[feedback] claimed questId belongs to another user's session; keys dropped", {
        claimedQuestId,
        userId,
      });
    }
  }

  if (claimedSessionId && (await ownsSession(claimedSessionId))) {
    return { ...base, sessionId: claimedSessionId, subject: 'session' };
  }

  return { ...base, subject: 'product' };
}
