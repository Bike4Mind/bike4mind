// Upper bound for a single voice call. Credits are reserved against this cap in
// POST /api/voice/v2/sessions and reconciled down to the actual call duration in
// POST /api/voice/v2/sessions/:id/end. Both endpoints import this single source
// so the reserve and the refund can never drift apart.
export const MAX_SESSION_SECONDS = 5 * 60;

/**
 * Credits actually owed for a call that ran `elapsedSeconds`, given the up-front
 * `reservedCredits` (which covered MAX_SESSION_SECONDS). The cost model is linear
 * in duration, so this is an exact proportional scale, clamped to [0, reserved].
 * The refund owed back to the user is `reservedCredits - this`.
 */
export function creditsForElapsed(reservedCredits: number, elapsedSeconds: number): number {
  const clamped = Math.max(0, Math.min(elapsedSeconds, MAX_SESSION_SECONDS));
  return Math.min(reservedCredits, Math.ceil((reservedCredits * clamped) / MAX_SESSION_SECONDS));
}

/**
 * Whether a voice-session bootstrap request should REUSE the session's existing
 * credit hold rather than reserving (and charging) a fresh one. True only when
 * the client explicitly flags a reconnect AND the session already carries a live
 * reservation (both `voiceReservedCredits` and `voiceSessionStartedAt` set - the
 * state left by a successful first connect, cleared on end-reconciliation).
 *
 * Both bootstrap endpoints (v1 /api/ai/voice-sessions, v2 /api/voice/v2/sessions)
 * call this so a reconnect can't double-charge: each mobile reconnect re-POSTs the
 * endpoint, and without this guard each would burn another full reservation that
 * the single end-reconciliation never refunds. The explicit-flag-plus-live-hold
 * test means a stray flag can never skip a legitimate first-connect charge.
 */
export function shouldReuseVoiceHold(
  isReconnect: boolean | undefined,
  session: { voiceReservedCredits?: number | null; voiceSessionStartedAt?: Date | null } | null | undefined
): boolean {
  return !!isReconnect && session?.voiceReservedCredits != null && session?.voiceSessionStartedAt != null;
}
