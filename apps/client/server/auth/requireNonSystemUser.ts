import { IUser } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';

/**
 * Throws ForbiddenError if the user is a system account.
 * Must be called at every auth surface that produces an authenticated user.
 * Returns the user unchanged for chaining convenience.
 *
 * NOTE: the OTC verify path (pages/api/otc/verify.ts) enforces this inline after
 * a code proves email ownership - it returns a generic post-verification error so
 * system/banned accounts are not turned into enumeration oracles.
 */
export function requireNonSystemUser<T extends Pick<IUser, 'isSystem'>>(user: T): T {
  if (user.isSystem) {
    throw new ForbiddenError('Cannot authenticate as a system account');
  }
  return user;
}
