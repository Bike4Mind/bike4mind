import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository, withTransaction } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { logEvent } from '@server/utils/analyticsLog';
import { emitEmailVerifiedFunnelEvents } from '@server/analytics/funnel';
import { AuthEvents } from '@bike4mind/common';
import { logAuditEvent, EmailAuditEvents, calculateTokenAge } from '@server/utils/auditLog';
import { applyEmailVerifiedGrants } from '@server/auth/emailVerifiedGrants';
import { z } from 'zod';

const VerifyEmailRequestSchema = z.object({
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
      const validatedData = VerifyEmailRequestSchema.parse(req.body);
      const { token } = validatedData;

      // Capture the user before verifyEmailToken clears the token fields, so the post-verify
      // grant block can still see the pending-free-credits tag (verifyEmailToken doesn't touch
      // tags but does null out the token, which makes a re-find by token impossible).
      const userBeforeVerify = await userRepository.findByEmailVerificationToken(token);

      // Phase 1: verify the token. Atomic within its own transaction - if verification fails,
      // the user's emailVerified state is left untouched and the client gets a 400 so they
      // can retry with a fresh link.
      try {
        await withTransaction(async () => {
          await userService.verifyEmailToken({ token }, { db: { users: userRepository } });
        });
      } catch (error) {
        if (userBeforeVerify) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          let auditEvent = EmailAuditEvents.EMAIL_VERIFICATION_FAILED;
          if (errorMessage.includes('already been used')) {
            auditEvent = EmailAuditEvents.EMAIL_VERIFICATION_TOKEN_REUSED;
          } else if (errorMessage.includes('expired')) {
            auditEvent = EmailAuditEvents.EMAIL_VERIFICATION_TOKEN_EXPIRED;
          }
          await logAuditEvent(
            {
              userId: userBeforeVerify.id,
              action: auditEvent,
              ip: req.ip,
              userAgent: req.headers['user-agent'] || 'unknown',
              tokenAge: userBeforeVerify.emailVerificationSentAt
                ? calculateTokenAge(userBeforeVerify.emailVerificationSentAt)
                : undefined,
              error: errorMessage,
            },
            req.logger
          );
        }
        throw error;
      }

      // Phase 2: the verification grants (deferred flat credits, then the verified domain's signup
      // grant). Runs OUTSIDE the verify transaction so a grant failure can't leave a partially
      // committed state; it never throws, and both grants are idempotent per user, so verification
      // still succeeds and a retry is safe. Fires independent of the pending-free-credits tag, so
      // invited domain users get the domain grant too. verifyEmailToken doesn't touch `email`, so
      // userBeforeVerify.email IS the now-verified address.
      const grants = userBeforeVerify?.email
        ? await applyEmailVerifiedGrants({
            user: userBeforeVerify,
            verifiedEmail: userBeforeVerify.email,
            trigger: 'email-verification',
            releaseReason: 'deferred registration credit grant (email verified)',
            logger: req.logger,
          })
        : null;
      const creditsGranted = grants ? grants.creditsGranted + grants.subscriptionCreditsGranted : 0;

      // Audit + analytics for the success path.
      if (userBeforeVerify) {
        await logAuditEvent(
          {
            userId: userBeforeVerify.id,
            action: EmailAuditEvents.EMAIL_VERIFICATION_SUCCESS,
            ip: req.ip,
            userAgent: req.headers['user-agent'] || 'unknown',
            tokenAge: userBeforeVerify.emailVerificationSentAt
              ? calculateTokenAge(userBeforeVerify.emailVerificationSentAt)
              : undefined,
          },
          req.logger
        );

        try {
          await logEvent({
            userId: userBeforeVerify.id,
            type: AuthEvents.EMAIL_VERIFIED,
            metadata: {},
          });
        } catch (error) {
          req.logger.warn('Failed to log email verification event:', error);
        }

        // Funnel floor (server/analytics/funnel.ts); never throws.
        await emitEmailVerifiedFunnelEvents({ user: userBeforeVerify, method: 'link', creditsGranted });
      }

      return res.json({ message: 'Email verified successfully' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
