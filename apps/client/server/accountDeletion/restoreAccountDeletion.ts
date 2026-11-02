import { NotFoundError } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';

/**
 * Clears a pending self-service deletion (POST /api/users/me/restore-deletion). Idempotent: restoring an
 * account that is not pending is a no-op reported as `restored: false`. Canceled subscriptions stay
 * canceled (Stripe cannot reinstate them); the user subscribes again.
 */
export async function restoreAccountDeletion(userId: string): Promise<{ restored: boolean }> {
  const restored = await userRepository.clearDeletionRequested(userId);
  if (!restored && !(await userRepository.findById(userId))) throw new NotFoundError('User not found');
  return { restored };
}
