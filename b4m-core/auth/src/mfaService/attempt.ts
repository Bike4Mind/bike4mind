import type { IUserDocument, IUserRepository } from '@bike4mind/common';
import { matchTOTPStep } from './utils';

export type MfaAttemptRepository = Pick<IUserRepository, 'atomicReserveMfaAttempt' | 'atomicClaimTotpStep'>;

/**
 * A second factor was refused: either the lockout blocked the attempt or the code was rejected.
 * The attempt was already counted when it was reserved, so callers respond from `attemptState`
 * (the user's lockout state after this attempt) and must not count it again.
 */
export class MfaAttemptRejectedError extends Error {
  constructor(
    message: string,
    readonly attemptState: IUserDocument | null
  ) {
    super(message);
    this.name = 'MfaAttemptRejectedError';
  }
}

/** Counts this attempt toward the lockout before any code is compared; throws when locked out. */
export async function reserveMfaAttempt(
  userId: string,
  repository: MfaAttemptRepository
): Promise<IUserDocument | null> {
  const { reserved, user } = await repository.atomicReserveMfaAttempt(userId);
  if (!reserved) throw new MfaAttemptRejectedError('Too many failed attempts.', user);
  return user;
}

/** Accepts a TOTP code at most once: returns the step it claimed, or null for a wrong or replayed code. */
export async function claimTOTPCode(
  userId: string,
  secret: string,
  token: string,
  repository: MfaAttemptRepository
): Promise<number | null> {
  const step = matchTOTPStep(secret, token);
  if (step === null) return null;
  return (await repository.atomicClaimTotpStep(userId, step)) ? step : null;
}
