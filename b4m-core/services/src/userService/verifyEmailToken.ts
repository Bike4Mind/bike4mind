import { IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY } from './sendEmailVerification';

const verifyEmailTokenSchema = z.object({
  token: z.string(),
});

export type VerifyEmailTokenParameters = z.infer<typeof verifyEmailTokenSchema>;

interface VerifyEmailTokenAdapters {
  db: {
    users: {
      findByEmailVerificationToken: (token: string) => Promise<IUserDocument | null>;
      update: (user: IUserDocument) => Promise<unknown>;
    };
  };
}

export const verifyEmailToken = async (
  params: VerifyEmailTokenParameters,
  { db }: VerifyEmailTokenAdapters
): Promise<void> => {
  const { token } = secureParameters(params, verifyEmailTokenSchema);

  const user = await db.users.findByEmailVerificationToken(token);

  if (!user || !user?.emailVerificationSentAt || !safeCompareTokens(token, user.emailVerificationToken || '')) {
    throw new BadRequestError('Invalid or expired verification token');
  }

  // Check if token has already been used (prevent reuse)
  if (user.emailVerificationUsed) {
    throw new BadRequestError('Verification token has already been used');
  }

  // Check if token has expired
  const tokenExpiry = user.emailVerificationExpires
    ? user.emailVerificationExpires
    : new Date(user.emailVerificationSentAt.getTime() + EMAIL_VERIFICATION_TOKEN_EXPIRY);

  if (tokenExpiry < new Date()) {
    throw new BadRequestError('Verification token has expired. Please request a new one.');
  }

  // Mark token as used FIRST (prevents race conditions)
  user.emailVerificationUsed = true;
  user.emailVerified = true;
  user.emailVerifiedAt = new Date();
  // Clear the verification token fields
  user.emailVerificationToken = null;
  user.emailVerificationSentAt = null;
  user.emailVerificationExpires = null;

  await db.users.update(user);
};
