import { IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const sendEmailVerificationSchema = z.object({
  userId: z.string(),
});

// 24 hours expiry for email verification (vs 2 hours for password reset)
export const EMAIL_VERIFICATION_TOKEN_EXPIRY = 86400000 as const;

export type SendEmailVerificationParameters = z.infer<typeof sendEmailVerificationSchema>;

interface SendEmailVerificationAdapters {
  db: {
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
      update: (user: IUserDocument) => Promise<unknown>;
    };
  };
  mailer: {
    sendEmailVerificationEmail: (user: IUserDocument, token: string) => Promise<void>;
  };
}

export const sendEmailVerification = async (
  params: SendEmailVerificationParameters,
  { db, mailer }: SendEmailVerificationAdapters
): Promise<void> => {
  const { userId } = secureParameters(params, sendEmailVerificationSchema);

  const user = await db.users.findById(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (!user.email) {
    throw new NotFoundError('User does not have an email address');
  }

  const token = randomUUID();

  user.emailVerificationToken = token;
  user.emailVerificationSentAt = new Date();
  user.emailVerificationExpires = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_EXPIRY);
  // Reset used flag when generating new token
  user.emailVerificationUsed = null;

  await db.users.update(user);

  await mailer.sendEmailVerificationEmail(user, token);
};
