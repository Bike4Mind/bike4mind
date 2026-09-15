import { sessionRepository, userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { creditsForElapsed } from '@server/voice/voiceSessionLimits';

// POST /api/voice/v2/sessions/:id/end - reconcile the up-front voice credit
// reservation down to the call's actual duration and refund the difference.
// Called by the browser when the call ends (user hangs up or ElevenLabs
// disconnects). Idempotent: a duplicate call after the hold is cleared is a no-op.
const handler = baseApi().post(async (req, res) => {
  const sessionId = req.query.id as string;

  // Owner-scoped fetch: only the session owner ends the call and receives the
  // refund. A shared-read user must never be able to touch another user's credits.
  const session = await sessionRepository.findByIdAndUserId(sessionId, req.user.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const reserved = session.voiceReservedCredits ?? 0;
  const startedAt = session.voiceSessionStartedAt ? new Date(session.voiceSessionStartedAt).getTime() : null;

  // Already reconciled (no hold left) or nothing was reserved (enforceCredits off):
  // clear any stale marker so the session stops counting as an active voice call.
  if (reserved <= 0 || !startedAt) {
    await sessionRepository.update({ id: session.id, voiceReservedCredits: null, voiceSessionStartedAt: null });
    return res.status(200).json({ refunded: 0, alreadyReconciled: true });
  }

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const owed = creditsForElapsed(reserved, elapsedSeconds);
  const refund = Math.max(0, reserved - owed);

  // Clear the hold BEFORE crediting back so a duplicate end can't double-refund.
  // A refund lost to a transient failure here is preferable to issuing free credits.
  await sessionRepository.update({ id: session.id, voiceReservedCredits: null, voiceSessionStartedAt: null });
  if (refund > 0) {
    await userRepository.incrementCredits(req.user.id, refund);
  }

  req.logger.info(
    { sessionId: session.id, elapsedSeconds, reserved, owed, refund },
    '[voice-v2/sessions/end] reconciled voice credits'
  );
  return res.status(200).json({ refunded: refund, elapsedSeconds });
});

export default handler;
