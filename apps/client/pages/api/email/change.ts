import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import {
  buildEmailChangeMailer,
  publishEmailChangeMessages,
  type EmailChangeMessage,
} from '@server/users/emailChangeMailer';
import { logAuditEvent, EmailAuditEvents } from '@server/utils/auditLog';
import { z } from 'zod';
import { stepUpGate } from '@server/auth/stepUp';

const ChangeEmailRequestSchema = z.object({
  // Normalized before the format check so a padded address is not rejected for its whitespace.
  newEmail: z.string().trim().toLowerCase().pipe(z.email()),
});

// Users change their own email from a browser session that recently re-verified.
const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .use(stepUpGate())
  .use(
    rateLimit({
      limit: 3, // 3 attempts
      windowMs: 15 * 60 * 1000, // 15 minutes
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const { newEmail } = ChangeEmailRequestSchema.parse(req.body);

      // Buffer emails so they are published AFTER the transaction commits.
      // Publishing to SQS inside a transaction would mean a rollback can't
      // un-publish the message, leading to emails sent for a write that didn't persist.
      const pendingEmails: EmailChangeMessage[] = [];

      await withTransaction(async () => {
        await userService.requestEmailChange(
          {
            userId: req.user.id,
            newEmail,
          },
          {
            db: {
              users: {
                findById: async (id: string) => userRepository.findById(id),
                existsOtherUserWithEmail: async (email: string, excludeUserId?: string) =>
                  userRepository.existsOtherUserWithEmail(email, excludeUserId),
                update: async user => userRepository.update(user),
              },
            },
            mailer: buildEmailChangeMailer(pendingEmails),
          }
        );

        // Log email change request (inside transaction - part of the write)
        await logAuditEvent(
          {
            userId: req.user.id,
            action: EmailAuditEvents.EMAIL_CHANGE_REQUESTED,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            oldEmail: req.user.email || undefined,
            newEmail,
          },
          req.logger
        );
      });

      await publishEmailChangeMessages(pendingEmails, req.logger, req.user.id);

      return res.json({ message: 'Email change verification sent. Please check your new email address.' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
