import { asyncHandler } from '@server/middlewares/asyncHandler';
import {
  userRepository,
  withTransaction,
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { logEvent } from '@server/utils/analyticsLog';
import { emitFunnelEvent } from '@server/analytics/funnel';
import { AuthEvents } from '@bike4mind/common';
import { logAuditEvent, EmailAuditEvents, calculateTokenAge } from '@server/utils/auditLog';
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';
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

      // Phase 2: best-effort credit grant + tag removal. Runs OUTSIDE the verify transaction
      // so a downstream failure here can't leave the user in a partially-committed state
      // (the prior implementation depended on the entire withTransaction block being atomic,
      // but a write committing out-of-transaction left users stranded with emailVerified=true
      // and credits=0 + pending tag still present, with no retry path). Idempotency layers:
      //  1) addCredits is keyed on a stable transactionId so a duplicate call is a no-op,
      //  2) tag removal is a set-difference filter, also idempotent.
      // If this throws, we log loudly but still return success - verification IS complete; the
      // grant can be retried by an admin/maintenance flow without re-issuing a new email token.
      // Summed across both grants below for the credits_granted funnel event.
      let creditsGranted = 0;
      if (userBeforeVerify) {
        const release = await userService.releasePendingFreeCredits(userBeforeVerify, {
          db: {
            adminSettings: adminSettingsRepository,
            creditTransactions: creditTransactionRepository,
            creditLots: creditLotRepository,
            users: userRepository,
          },
          reason: 'deferred registration credit grant (email verified)',
          logger: req.logger,
        });
        if (release.released) {
          try {
            await userRepository.update({ id: userBeforeVerify.id, ...release.patch });
            creditsGranted += release.creditsGranted;
            req.logger.info(
              release.creditsGranted > 0
                ? `Granted ${release.creditsGranted} deferred free credits to verified user ${userBeforeVerify.id}`
                : `Cleared pending-free-credits tag for user ${userBeforeVerify.id} (nothing to grant)`
            );
          } catch (updateError) {
            req.logger.error(
              `Email verified for user ${userBeforeVerify.id} but pending-free-credits tag removal failed; ` +
                `user is verified but still tagged pending-free-credits - needs manual retry`,
              updateError
            );
            // Deliberately swallow: verification succeeded, the user's email IS now verified,
            // and re-throwing would show them "Verification Failed" despite the success.
          }
        }
      }

      // Phase 2b: the verified domain's signup grant - one-time domain credits (ADDITIVE on top
      // of the flat grant above, distinct transactionId), partner-rule org membership, and the
      // entitlement cache wake-up. Fires INDEPENDENT of the pending-free-credits tag, so invited
      // domain users get it too. verifyEmailToken doesn't touch `email`, so userBeforeVerify.email
      // IS the now-verified address. Never throws (see applySignupDomainGrant).
      if (userBeforeVerify?.email) {
        const domainGrant = await applySignupDomainGrant({
          userId: userBeforeVerify.id,
          email: userBeforeVerify.email,
          trigger: 'email-verification',
          logger: req.logger,
        });
        creditsGranted += domainGrant.creditsGranted;
      }

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

        // Funnel floor (server/analytics/funnel.ts); both never throw.
        await emitFunnelEvent({ user: userBeforeVerify, event: 'email_verified', metadata: { method: 'link' } });
        if (creditsGranted > 0) {
          await emitFunnelEvent({
            user: userBeforeVerify,
            event: 'credits_granted',
            metadata: { amount: creditsGranted, source: 'signup', method: 'link' },
          });
        }
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
