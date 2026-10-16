import type { Response } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';

/** Sends the 423 for a locked-out user and returns true; false when the user may proceed. */
export function sendIfLockedOut(res: Response, user: IUserDocument): boolean {
  if (!mfaService.isUserLockedOut(user)) return false;
  const remainingMinutes = mfaService.getLockoutTimeRemaining(user);
  res.status(423).json({
    error: `Too many failed attempts. Please try again in ${remainingMinutes} minutes.`,
    lockedUntil: user.mfa?.lockedUntil,
    remainingMinutes,
  });
  return true;
}

/**
 * Respond to a rejected second factor from the shared MFA lockout: 423 once the limit is reached,
 * otherwise 400 with the attempts left. A TOTP/backup code refused by mfaService was already
 * counted when its attempt was reserved; any other rejection (a passkey) is counted here.
 */
export async function sendFailedMfaAttempt(
  res: Response,
  userId: string,
  body: { error: string; code?: string },
  error?: unknown
): Promise<Response> {
  const updatedUser =
    error instanceof mfaService.MfaAttemptRejectedError
      ? error.attemptState
      : await userRepository.atomicRecordMfaFailedAttempt(userId);
  if (updatedUser && sendIfLockedOut(res, updatedUser)) return res;
  return res.status(400).json({
    ...body,
    attemptsRemaining: mfaService.MAX_FAILED_ATTEMPTS - (updatedUser?.mfa?.failedAttempts ?? 0),
  });
}
