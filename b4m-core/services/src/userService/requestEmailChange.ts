import { Logger } from '@bike4mind/observability';
import { IUserDocument } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY } from './sendEmailVerification';

const requestEmailChangeSchema = z.object({
  userId: z.string(),
  newEmail: z.email(),
});

export type RequestEmailChangeParameters = z.infer<typeof requestEmailChangeSchema>;

interface RequestEmailChangeAdapters {
  db: {
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
      findByEmail: (email: string) => Promise<IUserDocument | null>;
      update: (user: IUserDocument) => Promise<unknown>;
    };
  };
  mailer: {
    sendEmailChangeVerification: (user: IUserDocument, newEmail: string, token: string) => Promise<void>;
    sendEmailChangeNotification?: (user: IUserDocument, newEmail: string) => Promise<void>;
  };
}

export const requestEmailChange = async (
  params: RequestEmailChangeParameters,
  { db, mailer }: RequestEmailChangeAdapters
): Promise<void> => {
  const { userId, newEmail } = secureParameters(params, requestEmailChangeSchema);

  const user = await db.users.findById(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  // Check if new email is same as current email
  if (user.email?.toLowerCase() === newEmail.toLowerCase()) {
    throw new BadRequestError('New email must be different from current email');
  }

  // Check if new email is already taken by another user
  const existingUser = await db.users.findByEmail(newEmail);
  if (existingUser && existingUser.id !== user.id) {
    // Silent fail to prevent email enumeration: don't send email or update user,
    // so attackers can't discover which emails are registered.
    return;
  }

  const token = randomUUID();

  user.pendingEmail = newEmail;
  user.pendingEmailToken = token;
  user.pendingEmailSentAt = new Date();
  user.pendingEmailExpires = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_EXPIRY);
  // Reset used flag when generating new token
  user.pendingEmailUsed = null;

  await db.users.update(user);

  // Send security notification to current email address
  if (mailer.sendEmailChangeNotification) {
    try {
      await mailer.sendEmailChangeNotification(user, newEmail);
    } catch (error) {
      // Log but don't fail the request if notification fails
      Logger.globalInstance.error('Failed to send email change notification to old address:', error);
    }
  }

  // Send verification email to new email address
  await mailer.sendEmailChangeVerification(user, newEmail, token);
};
