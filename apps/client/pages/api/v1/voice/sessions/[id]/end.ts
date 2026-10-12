/**
 * POST /api/v1/voice/sessions/{id}/end - reconcile the up-front voice credit reservation down to
 * the call's connected time and refund the difference. Called when the call ends (user hangs up
 * or ElevenLabs disconnects). Idempotent: a duplicate call after the hold is cleared is a no-op.
 * Also served at the legacy `/api/voice/v2/sessions/{id}/end` (re-exported there), which the SPA
 * calls. Auth mode, the `ai:generate` scope and the path param come from `endVoiceSessionContract`.
 */
import { sessionRepository } from '@bike4mind/database';
import { endVoiceSessionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { settleVoiceHold } from '@server/voice/settleVoiceHold';

const handler = nextRouteForContract(endVoiceSessionContract).post(async (req, res) => {
  const sessionId = req.validatedParams.id;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(sessionId)) throw new NotFoundError('Session not found');

  // Owner-scoped fetch: only the session owner ends the call and receives the
  // refund. A shared-read user must never be able to touch another user's credits.
  const session = await sessionRepository.findByIdAndUserId(sessionId, req.user.id);
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const reserved = session.voiceReservedCredits ?? 0;
  const startedAt = session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt) : null;

  // Already reconciled (no hold left) or nothing was reserved (enforceCredits off):
  // clear any stale marker so the session stops counting as an active voice call.
  if (reserved <= 0 || !startedAt) {
    await sessionRepository.update({ id: session.id, voiceReservedCredits: null, voiceSessionStartedAt: null });
    return res.status(200).json({ refunded: 0, alreadyReconciled: true });
  }

  const settlement = await settleVoiceHold(
    {
      id: session.id,
      userId: req.user.id,
      voiceReservedCredits: reserved,
      voiceSessionStartedAt: startedAt,
      voiceConnectedAt: session.voiceConnectedAt ?? null,
    },
    // Ending the call is itself the call's last activity.
    { kind: 'connected-time', endedAt: new Date() },
    'end'
  );
  // A concurrent end or the stale-hold sweep settled it first.
  if (!settlement.settled) {
    return res.status(200).json({ refunded: 0, alreadyReconciled: true });
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
  return res.status(200).json({ refunded: settlement.refundedCredits, elapsedSeconds });
});

export default handler;
