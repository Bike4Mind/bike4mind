import { dayjs } from '@bike4mind/common';

/** Hours a rotated-out ("previous") secret stays valid after a rotation. */
export const SECRET_ROTATION_GRACE_HOURS = 24;

/**
 * Single source of truth for the JWT-secret rotation grace window: whether a
 * rotated secret is recent enough that its `previousKey` may still be trusted.
 * Returns false when there is no recorded rotation.
 *
 * SECURITY: every path that accepts a token signed with the previous JWT_SECRET
 * (currently: the Passport JWT strategy, the refresh endpoint, identify, and the
 * WebSocket subscribe/unsubscribe handlers) MUST use this so the window cannot
 * drift between them. Paths that only ever verify against the current secret (no
 * previous-key fallback), e.g. the CLI verifier and the WS connect handler, have
 * no grace window to apply and don't need it. It is bounded on the RECENT side
 * (`isAfter(now - grace)`); an unbounded form would keep the previous secret valid
 * indefinitely and defeat rotation as a kill switch.
 */
export function isRotatedSecretWithinGraceWindow(rotatedAt?: Date | string | null): boolean {
  if (!rotatedAt) return false;
  return dayjs(rotatedAt).isAfter(dayjs().subtract(SECRET_ROTATION_GRACE_HOURS, 'hours'));
}
