import { IUserDocument } from '@bike4mind/common';
import { BadRequestError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { safeCompareTokens } from '../utils/crypto';

const verifyEmailChangeSchema = z.object({
  token: z.string(),
});

export type VerifyEmailChangeParameters = z.infer<typeof verifyEmailChangeSchema>;

interface VerifyEmailChangeAdapters {
  db: {
    users: {
      findByPendingEmailToken: (token: string) => Promise<IUserDocument | null>;
      update: (user: Partial<IUserDocument>) => Promise<unknown>;
    };
  };
}

export const verifyEmailChange = async (
  params: VerifyEmailChangeParameters,
  { db }: VerifyEmailChangeAdapters
): Promise<void> => {
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

  await db.users.update({
    id: user.id,
    // Mark token as used FIRST (prevents race conditions)
    pendingEmailUsed: true,
    email: user.pendingEmail,
    // Clear pending email fields
    pendingEmail: null,
    pendingEmailToken: null,
    pendingEmailSentAt: null,
    pendingEmailExpires: null,
    // Since email changed, mark as verified with current timestamp
    emailVerified: true,
    emailVerifiedAt: new Date(),
  });
};
