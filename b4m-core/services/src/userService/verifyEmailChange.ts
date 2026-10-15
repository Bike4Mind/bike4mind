import { ConflictError, IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { isDuplicateKeyErrorOn } from './duplicateKeyError';

const verifyEmailChangeSchema = z.object({
  token: z.string(),
});

export type VerifyEmailChangeParameters = z.infer<typeof verifyEmailChangeSchema>;

export const EMAIL_NO_LONGER_AVAILABLE_MESSAGE = 'This email address is no longer available.';

interface VerifyEmailChangeAdapters {
  db: {
    users: {
      findByPendingEmailToken: (token: string) => Promise<IUserDocument | null>;
      existsOtherUserWithEmail: (email: string, excludeUserId?: string) => Promise<boolean>;
      update: (user: Partial<IUserDocument>) => Promise<unknown>;
    };
  };
}

export const verifyEmailChange = async (
  params: VerifyEmailChangeParameters,
  { db }: VerifyEmailChangeAdapters
): Promise<'changed' | 'unavailable'> => {
  const { token } = secureParameters(params, verifyEmailChangeSchema);

  const user = await db.users.findByPendingEmailToken(token);

  if (
    !user ||
    !user?.pendingEmailSentAt ||
    !user?.pendingEmail ||
    !safeCompareTokens(token, user.pendingEmailToken || '')
  ) {
    throw new BadRequestError('Invalid or expired email change token');
  }

  // Check if token has already been used (prevent reuse)
  if (user.pendingEmailUsed) {
    throw new BadRequestError('Email change token has already been used');
  }

  // Check if token is expired
  const tokenExpiry = user.pendingEmailExpires || new Date(user.pendingEmailSentAt.getTime() + 86400000); // 24 hours default

  if (tokenExpiry < new Date()) {
    throw new BadRequestError('Email change token has expired. Please request a new email change.');
  }

  const newEmail = user.pendingEmail.trim().toLowerCase();
  const clearPending = {
    pendingEmail: null,
    pendingEmailToken: null,
    pendingEmailSentAt: null,
    pendingEmailExpires: null,
  };

  // Another account can claim the address between request and verify; the request-time check
  // alone cannot see that. The token is burned so the same link cannot be retried. The caller
  // turns 'unavailable' into a 409 after the transaction commits, so the burn is not rolled back.
  if (await db.users.existsOtherUserWithEmail(newEmail, user.id)) {
    await db.users.update({ id: user.id, pendingEmailUsed: true, ...clearPending });
    return 'unavailable';
  }

  try {
    await db.users.update({
      id: user.id,
      // Single-use: burned in the same write that applies the change
      pendingEmailUsed: true,
      email: newEmail,
      ...clearPending,
      // Since email changed, mark as verified with current timestamp
      emailVerified: true,
      emailVerifiedAt: new Date(),
      // A link sent to the old address must not verify the new one: /api/email/verify grants by the
      // account's CURRENT email, so a stale link would hand over the new domain's signup grant.
      emailVerificationToken: null,
      emailVerificationExpires: null,
      emailVerificationSentAt: null,
    });
    return 'changed';
  } catch (error) {
    // Lost a race with a concurrent claim of the same exact address after the check above.
    // The server has aborted the transaction, so a burn write cannot land: the token is not
    // burned on this rare race.
    if (isDuplicateKeyErrorOn(error, 'email')) {
      throw new ConflictError(EMAIL_NO_LONGER_AVAILABLE_MESSAGE);
    }
    throw error;
  }
};
