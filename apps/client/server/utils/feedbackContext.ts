import { FeedbackSubject } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { questRepository, sessionRepository } from '@bike4mind/database';
import mongoose from 'mongoose';

export interface ResolvedFeedbackContext {
  questId?: string;
  sessionId?: string;
  /** The authenticated submitter's own organization only - never derived from a claim. */
  organizationId: string | null;
  subject: FeedbackSubject;
}

interface ResolveFeedbackContextArgs {
  /** Absent for an unauthenticated submission. */
  authenticatedUserId?: string;
  /** Already resolved from the authenticated User doc - not re-derived here. */
  organizationId: string | null;
  /**
   * Untrusted pointers from the request, NOT authorization keys - each is re-read and
   * ownership-checked server-side before it survives into the returned context. A `promptMeta`
   * copy of either must never be read directly; only these top-level claims are considered.
   */
  claims: {
    questId?: string;
    sessionId?: string;
  };
  logger: Pick<Logger, 'warn'>;
}

/**
 * Derives the Feedback record's authorization-bearing fields (organizationId, questId,
 * sessionId, subject) from the authenticated session and a server-side re-read of the claimed
 * quest/session - never from client-supplied values. These fields become authorization keys for
 * downstream scoped readers, so a claim that cannot be verified is dropped rather than trusted.
 *
 * A dropped claim still returns 201 (see the create handler) rather than a 4xx: erroring on a
 * stale or foreign quest id would both lose an honest report and confirm to a caller that the id
 * they guessed belongs to someone else's quest - a no-op drop leaks nothing and still saves the
 * report the reporter meant to send.
 */
export async function resolveFeedbackContext({
  authenticatedUserId,
  organizationId,
  claims,
  logger,
}: ResolveFeedbackContextArgs): Promise<ResolvedFeedbackContext> {
  if (!authenticatedUserId) {
    // An unauthenticated caller supplies its own identity fields (userEmail, etc.) - trusting
    // any of them for an authorization key would let anyone claim another org's feedback simply
    // by typing a member's email into the request body.
    return { organizationId: null, subject: 'product' };
  }

  const resolvedSessionId = await resolveOwnedSessionId(claims, authenticatedUserId, logger);

  return {
    questId: resolvedSessionId.questId,
    sessionId: resolvedSessionId.sessionId,
    organizationId,
    subject: resolvedSessionId.questId ? 'turn' : resolvedSessionId.sessionId ? 'session' : 'product',
  };
}

async function resolveOwnedSessionId(
  claims: ResolveFeedbackContextArgs['claims'],
  authenticatedUserId: string,
  logger: Pick<Logger, 'warn'>
): Promise<{ questId?: string; sessionId?: string }> {
  if (claims.questId) {
    if (!mongoose.isValidObjectId(claims.questId)) {
      logger.warn(`Dropped feedback questId claim: not a valid ObjectId (${claims.questId})`);
    } else {
      const quest = await questRepository.findById(claims.questId);
      if (!quest) {
        logger.warn('Dropped feedback questId claim: quest not found');
      } else if (await isSessionOwnedBy(quest.sessionId, authenticatedUserId, logger)) {
        return { questId: claims.questId, sessionId: quest.sessionId };
      } else {
        logger.warn('Dropped feedback questId claim: quest not owned by the submitting user');
      }
    }
  }

  if (claims.sessionId) {
    if (!mongoose.isValidObjectId(claims.sessionId)) {
      logger.warn(`Dropped feedback sessionId claim: not a valid ObjectId (${claims.sessionId})`);
    } else if (await isSessionOwnedBy(claims.sessionId, authenticatedUserId, logger)) {
      return { sessionId: claims.sessionId };
    }
  }

  return {};
}

async function isSessionOwnedBy(
  sessionId: string,
  authenticatedUserId: string,
  logger: Pick<Logger, 'warn'>
): Promise<boolean> {
  const session = await sessionRepository.findById(sessionId);
  if (!session) {
    logger.warn('Dropped feedback session claim: session not found');
    return false;
  }
  return session.userId === authenticatedUserId || session.users?.some(share => share.userId === authenticatedUserId);
}
