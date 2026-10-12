/**
 * POST /api/v1/voice/sessions/{id}/end - reconcile the up-front voice credit reservation down to
 * the call's actual duration and refund the difference. Called when the call ends (user hangs up
 * or ElevenLabs disconnects). Idempotent: a duplicate call after the hold is cleared is a no-op.
 * Also served at the legacy `/api/voice/v2/sessions/{id}/end` (re-exported there), which the SPA
 * calls. Auth mode, the `ai:generate` scope and the path param come from `endVoiceSessionContract`.
 */
import { sessionRepository } from '@bike4mind/database';
import { endVoiceSessionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { BadGatewayError, ConflictError, NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { measureVoiceCallSeconds } from '@server/voice/measureVoiceCall';
import { settleVoiceHold } from '@server/voice/settleVoiceHold';

const handler = nextRouteForContract(endVoiceSessionContract).post(async (req, res) => {
  const sessionId = req.validatedParams.id;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(sessionId)) throw new NotFoundError('Session not found');

  // Owner-scoped fetch: only the session owner ends the call and receives the
  // refund. A shared-read user must never be able to touch another user's credits.
  // includeDeleted: deleting the notebook mid-call must not strand the reservation.
  const session = await sessionRepository.findByIdAndUserId(sessionId, req.user.id, { includeDeleted: true });
  if (!session) {
    throw new NotFoundError('Session not found');
  }

  const reserved = session.voiceReservedCredits ?? 0;
  const startedAt = session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt) : null;

  // Already reconciled (no hold left) or nothing was reserved (enforceCredits off):
  // clear any stale marker so the session stops counting as an active voice call.
  if (reserved <= 0 || !startedAt) {
    await sessionRepository.update(
      { id: session.id, voiceReservedCredits: null, voiceSessionStartedAt: null, voiceProviderConversationIds: [] },
      { includeDeleted: true }
    );
    return res.status(200).json({ refunded: 0, alreadyReconciled: true });
  }

  const hold = {
    id: session.id,
    userId: req.user.id,
    voiceReservedCredits: reserved,
    voiceSessionStartedAt: startedAt,
    voiceProviderConversationIds: session.voiceProviderConversationIds ?? [],
  };
  const measurement = await measureVoiceCallSeconds(hold);
  switch (measurement.kind) {
    case 'live':
      // Billing a running call at its duration so far would let the caller keep talking unbilled.
      throw new ConflictError('The voice call is still in progress; end it before settling');
    case 'pending':
      throw new ConflictError('The voice provider has not recorded this call yet; retry shortly');
    case 'unverifiable':
      req.logger.warn(
        { sessionId: session.id, reason: measurement.reason },
        '[voice-v2/sessions/end] usage unverifiable'
      );
      throw new BadGatewayError('Could not verify voice call usage with the provider; retry later');
  }

  const { elapsedSeconds } = measurement;
  const settlement = await settleVoiceHold(hold, elapsedSeconds);
  // A concurrent end or the stale-hold sweep settled it first.
  if (!settlement.settled) {
    return res.status(200).json({ refunded: 0, alreadyReconciled: true });
  }
  const { owed, refund } = settlement;

  req.logger.info(
    { sessionId: session.id, elapsedSeconds, source: measurement.source, reserved, owed, refund },
    '[voice-v2/sessions/end] reconciled voice credits'
  );
  return res.status(200).json({ refunded: refund, elapsedSeconds });
});

export default handler;
