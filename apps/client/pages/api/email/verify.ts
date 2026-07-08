import { asyncHandler } from '@server/middlewares/asyncHandler';
import {
  userRepository,
  withTransaction,
  adminSettingsRepository,
  creditTransactionRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService, creditService } from '@bike4mind/services';
import { CreditHolderType, PENDING_FREE_CREDITS_TAG, settingsMap } from '@bike4mind/common';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { logEvent } from '@server/utils/analyticsLog';
import { AuthEvents } from '@bike4mind/common';
import { logAuditEvent, EmailAuditEvents, calculateTokenAge } from '@server/utils/auditLog';
import { entitlementsForEmail, signupCreditsForKeys } from '@client/lib/entitlements/registry';
import { partnerSignupGrantForEmail } from '@server/entitlements/partnerRules';
import { pushEntitlementInvalidation } from '@server/entitlements/invalidate';
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
      if (userBeforeVerify?.tags?.includes(PENDING_FREE_CREDITS_TAG)) {
        try {
          // An invite-resolved pending amount travels on the user doc and wins;
          // the defaultFreeCredits setting remains the open-registration fallback.
          let amount = userBeforeVerify.pendingCreditGrant ?? null;
          if (amount === null) {
            const setting = await adminSettingsRepository.findBySettingName('defaultFreeCredits');
            const parsed = settingsMap.defaultFreeCredits.schema.safeParse(setting?.settingValue);
            amount = parsed.success ? parsed.data : 0;
          }
          if (amount > 0) {
            await creditService.addCredits(
              {
                ownerId: userBeforeVerify.id,
                ownerType: CreditHolderType.User,
                credits: amount,
                type: 'generic_add',
                transactionId: `verify-grant:${userBeforeVerify.id}`,
                reason: 'deferred registration credit grant (email verified)',
              },
              { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
            );
            req.logger.info(`Granted ${amount} deferred free credits to verified user ${userBeforeVerify.id}`);
          } else {
            req.logger.info(`Cleared pending-free-credits tag for user ${userBeforeVerify.id} (nothing to grant)`);
          }
          await userRepository.update({
            id: userBeforeVerify.id,
            tags: userBeforeVerify.tags.filter(t => t !== PENDING_FREE_CREDITS_TAG),
            pendingCreditGrant: null,
          });
        } catch (grantError) {
          req.logger.error(
            `Email verified for user ${userBeforeVerify.id} but credit grant/tag-removal failed; ` +
              `user is verified but still tagged pending-free-credits — needs manual retry`,
            grantError
          );
          // Deliberately swallow: verification succeeded, the user's email IS now verified,
          // and re-throwing would show them "Verification Failed" despite the success.
        }
      }

      // Resolve the now-verified email's domain grant ONCE - both the signup-credit grant
      // (Phase 2b) and the cache-invalidation gate (below) need the keys, and Phase 2b needs
      // the credit amount. Passing `true` is accurate: verifyEmailToken just succeeded and
      // doesn't touch `email`, so userBeforeVerify.email IS the now-verified address.
      //
      // Source precedence (issue #293): a DB-backed PartnerSignupRule wins; the env registry
      // (`entitlementsForEmail` / `signupCreditsForKeys`) is the migration fallback for a
      // domain not yet in the collection. `matched` lets a DB rule intentionally grant access
      // with 0 bonus credits without falling through to the env amount.
      let domainGrantKeys = new Set<string>();
      let signupCredits = 0;
      if (userBeforeVerify) {
        const partnerGrant = await partnerSignupGrantForEmail(userBeforeVerify.email, true);
        if (partnerGrant.matched) {
          domainGrantKeys = partnerGrant.entitlements;
          signupCredits = partnerGrant.signupCredits;
        } else {
          domainGrantKeys = entitlementsForEmail(userBeforeVerify.email, true);
          signupCredits = signupCreditsForKeys(domainGrantKeys);
        }
      }

      // Phase 2b: one-time domain-grant signup credits. Fires whenever the now-verified
      // email confers a domain grant (e.g. a partner-domain or internal-staff address), INDEPENDENT
      // of the pending-free-credits tag - so invited domain users get it too, not just
      // open-registration signups. ADDITIVE on top of the flat grant above (distinct
      // transactionId), and idempotent via the stable `domain-grant-credits:${userId}` id so
      // a re-verify / handler retry can't double-grant. Own try/catch so a failure here (or in
      // the flat grant above) can't skip the other.
      if (userBeforeVerify) {
        try {
          if (signupCredits > 0) {
            await creditService.addCredits(
              {
                ownerId: userBeforeVerify.id,
                ownerType: CreditHolderType.User,
                credits: signupCredits,
                type: 'generic_add',
                transactionId: `domain-grant-credits:${userBeforeVerify.id}`,
                reason: 'domain-grant signup credits',
              },
              { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
            );
            req.logger.info(
              `Granted ${signupCredits} one-time domain-grant signup credits to verified user ${userBeforeVerify.id}`
            );
          }
        } catch (grantError) {
          req.logger.error(
            `Email verified for user ${userBeforeVerify.id} but domain-grant signup-credit grant failed; ` +
              `idempotent transactionId domain-grant-credits:${userBeforeVerify.id} makes a retry safe`,
            grantError
          );
          // Deliberately swallow: verification succeeded; re-throwing would show the user
          // "Verification Failed" despite the success. The stable transactionId lets an
          // admin/maintenance flow retry the grant without re-issuing an email token.
        }
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
      }

      // Wake the client entitlement gate when the now-verified email confers a
      // domain grant (ACCESS_MODEL §3.1 - derive-on-read DOMAIN_GRANTS, e.g. a
      // partner-domain address). Reuses the keys resolved once above.
      if (userBeforeVerify && domainGrantKeys.size > 0) {
        await pushEntitlementInvalidation(userBeforeVerify.id, req.logger);
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
