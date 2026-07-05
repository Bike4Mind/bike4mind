import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { logEvent } from '@server/utils/analyticsLog';
import { AuthEvents } from '@bike4mind/common';
import { logAuditEvent, EmailAuditEvents, calculateTokenAge } from '@server/utils/auditLog';
import { entitlementsForEmail } from '@client/lib/entitlements/registry';
import { pushEntitlementInvalidation } from '@server/entitlements/invalidate';
import { z } from 'zod';

const VerifyEmailChangeRequestSchema = z.object({
  token: z.string(),
});

// No auth required - public endpoint for token verification
const handler = baseApi({ auth: false })
  .use(csrfProtection())
  .use(
    rateLimit({
      limit: 10, // 10 attempts
      windowMs: 15 * 60 * 1000, // 15 minutes
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const validatedData = VerifyEmailChangeRequestSchema.parse(req.body);
      const { token } = validatedData;

      // Find the user with the pending email token
      const user = await userRepository.findByPendingEmailToken(token);

      if (!user) {
        return res.status(400).json({ error: 'Invalid or expired email change token' });
      }

      const oldEmail = user.email;
      const newEmail = user.pendingEmail;

      try {
        // Verify the token and complete email change
        await userService.verifyEmailChange(
          { token },
          {
            db: {
              users: {
                findByPendingEmailToken: async (token: string) => userRepository.findByPendingEmailToken(token),
                update: async user => userRepository.update(user),
              },
            },
          }
        );

        // Log successful email change
        await logAuditEvent(
          {
            userId: user.id,
            action: EmailAuditEvents.EMAIL_CHANGE_SUCCESS,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            oldEmail: oldEmail || undefined,
            newEmail: newEmail || undefined,
            tokenAge: user.pendingEmailSentAt ? calculateTokenAge(user.pendingEmailSentAt) : undefined,
          },
          req.logger
        );

        // Log to existing analytics system
        try {
          await logEvent({
            userId: user.id,
            type: AuthEvents.EMAIL_VERIFIED,
            metadata: {},
          });
        } catch (error) {
          req.logger.warn('Failed to log email change event:', error);
        }

        // Wake the client entitlement gate when the change crosses a domain
        // grant boundary (derive-on-read DOMAIN_GRANTS) - checking EITHER the old
        // or new address covers both gaining (moved TO a partner-domain address) and
        // losing it (moved AWAY). After verifyEmailChange, `newEmail` is now
        // `user.email`. The verifyEmailChange success path always sets a non-null
        // pendingEmail, and entitlementsForEmail tolerates null regardless.
        //
        // Access (derive-on-read) updates here, but the one-time signup credits
        // (see verify.ts Phase 2b) are DELIBERATELY not granted on email change -
        // they are strictly a signup-time perk, and gating them here would open an
        // email-swap credit-farming vector. The idempotent `domain-grant-credits:`
        // key means adding it here later (if product wants it) stays safe.
        if (entitlementsForEmail(oldEmail, true).size > 0 || entitlementsForEmail(newEmail, true).size > 0) {
          await pushEntitlementInvalidation(user.id, req.logger);
        }

        return res.json({ message: 'Email changed successfully. Please log in with your new email address.' });
      } catch (error) {
        // Log failed email change attempt with specific event types
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        let auditEvent = EmailAuditEvents.EMAIL_CHANGE_FAILED;

        // Detect specific error types for better audit trail
        if (errorMessage.includes('already been used')) {
          auditEvent = EmailAuditEvents.EMAIL_CHANGE_TOKEN_REUSED;
        } else if (errorMessage.includes('expired')) {
          auditEvent = EmailAuditEvents.EMAIL_CHANGE_TOKEN_EXPIRED;
        }

        await logAuditEvent(
          {
            userId: user.id,
            action: auditEvent,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            oldEmail: oldEmail || undefined,
            newEmail: newEmail || undefined,
            tokenAge: user.pendingEmailSentAt ? calculateTokenAge(user.pendingEmailSentAt) : undefined,
            error: errorMessage,
          },
          req.logger
        );
        throw error;
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
