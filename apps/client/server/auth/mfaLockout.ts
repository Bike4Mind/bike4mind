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
 * Count a rejected second factor toward the shared MFA lockout and respond: 423 once the limit
 * is reached, otherwise 400 with the attempts left.
 */
export async function sendFailedMfaAttempt(
  res: Response,
  userId: string,
  body: { error: string; code?: string }
): Promise<Response> {
  const updatedUser = await userRepository.atomicRecordMfaFailedAttempt(userId);
  if (updatedUser && sendIfLockedOut(res, updatedUser)) return res;
  return res.status(400).json({
    ...body,
    attemptsRemaining: mfaService.MAX_FAILED_ATTEMPTS - (updatedUser?.mfa?.failedAttempts ?? 0),
  });
}
