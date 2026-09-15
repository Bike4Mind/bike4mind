import { IUserDocument } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY } from './sendEmailVerification';

const resendEmailVerificationSchema = z.object({
  userId: z.string(),
});

export type ResendEmailVerificationParameters = z.infer<typeof resendEmailVerificationSchema>;

interface ResendEmailVerificationAdapters {
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

export const resendEmailVerification = async (
  params: ResendEmailVerificationParameters,
  { db, mailer }: ResendEmailVerificationAdapters
): Promise<void> => {
  const { userId } = secureParameters(params, resendEmailVerificationSchema);

  const user = await db.users.findById(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (!user.email) {
    throw new NotFoundError('User does not have an email address');
  }

  // Check if already verified
  if (user.emailVerified) {
    throw new BadRequestError('Email is already verified');
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
