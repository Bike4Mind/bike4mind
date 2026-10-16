import type { IUserDocument, IUserRepository } from '@bike4mind/common';
import { matchTOTPStep } from './utils';

export type MfaAttemptRepository = Pick<IUserRepository, 'atomicReserveMfaAttempt' | 'atomicClaimTotpStep'>;

/**
 * A second-factor attempt failed AFTER it was counted toward the lockout: the lockout refused
 * it, the code was rejected, or verification broke after the reservation. Callers respond from
 * `attemptState` (the user's lockout state after this attempt) and must not count it again.
 */
export class MfaAttemptRejectedError extends Error {
  constructor(
    message: string,
    readonly attemptState: IUserDocument | null,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'MfaAttemptRejectedError';
  }
}

/**
 * Matched by name, not instanceof: the class is thrown from this package and caught in apps that
 * may load a second copy of it (as asPasskeyError in apps/client/server/auth/passkey.ts does).
 */
export function isMfaAttemptRejectedError(error: unknown): error is MfaAttemptRejectedError {
  return error instanceof Error && error.name === 'MfaAttemptRejectedError';
}

/**
 * Counts one attempt toward the lockout BEFORE `verify` compares any code, so concurrent guesses
 * cannot all slip past the lockout check. Throws when locked out; any failure inside `verify` is
 * rethrown as MfaAttemptRejectedError so the caller does not count the attempt a second time.
 */
export async function withReservedMfaAttempt<T>(
  userId: string,
  repository: MfaAttemptRepository,
  verify: (attemptState: IUserDocument | null) => Promise<T>
): Promise<T> {
  const { reserved, user: attemptState } = await repository.atomicReserveMfaAttempt(userId);
  if (!reserved) throw new MfaAttemptRejectedError('Too many failed attempts.', attemptState);
  try {
    return await verify(attemptState);
  } catch (error) {
    if (isMfaAttemptRejectedError(error)) throw error;
    const message = error instanceof Error ? error.message : 'MFA verification failed';
    throw new MfaAttemptRejectedError(message, attemptState, { cause: error });
  }
}

/**
 * The lockout state to respond with after a failed second factor: taken from the error when the
 * attempt was already counted, otherwise counted now (a passkey, or a failure before reserving).
 */
export async function recordFailedMfaAttempt(
  error: unknown,
  userId: string,
  repository: Pick<IUserRepository, 'atomicRecordMfaFailedAttempt'>
): Promise<IUserDocument | null> {
  if (isMfaAttemptRejectedError(error)) return error.attemptState;
  return repository.atomicRecordMfaFailedAttempt(userId);
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
