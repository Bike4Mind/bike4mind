import { accessibleBy } from '@casl/mongoose';
import { Permission, type IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { Session } from '@bike4mind/database/auth';
import { assertAiAccessAllowed } from '@server/auth/assertAiAccessAllowed';
import { SessionEvents } from '@server/utils/eventBus';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { assertSessionOperationalCredits } from '@server/utils/sessionOperationalCreditPreflight';

export type QueueSessionTagsResult = {
  queued: { sessionId: string; requestId: Awaited<ReturnType<typeof SessionEvents.Tag.publish>> }[];
  /** Malformed ids and sessions the caller cannot update. Nothing is queued or billed for them. */
  inaccessible: string[];
};

/**
 * Queues AI tagging for every session the caller can update. Used by POST /api/sessions/[id]/tag
 * and the bulk `generateTags` action. The credit pre-flight runs once, sized to all accessible
 * sessions, before anything is published, so a refusal queues nothing.
 */
export async function queueSessionTags(
  req: { user?: IUserDocument; ability?: Parameters<typeof accessibleBy>[0]; logger?: Logger },
  sessionIds: string[]
): Promise<QueueSessionTagsResult> {
  const validIds = [...new Set(sessionIds.filter(id => isValidObjectId(id)))];
  const sessions = validIds.length
    ? await Session.find({
        _id: { $in: validIds },
        ...accessibleBy(req.ability!, Permission.update).ofType(Session),
      })
    : [];
  const accessible = new Set(sessions.map(s => String(s.id)));
  const inaccessible = sessionIds.filter(id => !accessible.has(id));
  if (sessions.length === 0) return { queued: [], inaccessible };

  assertAiAccessAllowed(req.user);

  // Queueing the tag IS the spend, so a refusal is the answer to this request.
  // Billed to whoever asked (payerId below), never the owner on a sharee's behalf.
  await assertSessionOperationalCredits({
    userId: req.user!.id,
    operationCount: sessions.length,
    operation: 'session tagging',
    logger: req.logger,
  });

  // An admin reaches this via CASL's admin-wide Session update, which the handler's share-arm
  // re-check can't express, so their job re-checks as the owner instead (still not-deleted).
  const requesterId = req.user?.isAdmin ? undefined : req.user?.id;
  const queued: QueueSessionTagsResult['queued'] = [];
  for (const session of sessions) {
    const requestId = await SessionEvents.Tag.publish({ sessionId: session.id, requesterId, payerId: req.user!.id });
    queued.push({ sessionId: String(session.id), requestId });
  }
  return { queued, inaccessible };
}
