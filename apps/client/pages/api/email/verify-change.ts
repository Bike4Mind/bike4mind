import { asyncHandler } from '@server/middlewares/asyncHandler';
import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { userService } from '@bike4mind/services';
import { commitWithSessionEnd } from '@server/auth/endUserSessions';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { logEvent } from '@server/utils/analyticsLog';
import { AuthEvents, ConflictError } from '@bike4mind/common';
import { calculateTokenAge } from '@server/utils/auditLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { entitlementsForEmail } from '@bike4mind/server-utils/lib/entitlements/registry';
import { pushEntitlementInvalidation } from '@server/entitlements/invalidate';
import { isEligibleForFreeCredits, releaseVerifiedPendingFreeCredits } from '@server/auth/emailVerifiedGrants';
import { z } from 'zod';

const VerifyEmailChangeRequestSchema = z.object({
  token: z.string(),
});

/** Classifies a failed confirmation by the service's error message, so token misuse stands out in the audit trail. */
const emailChangeFailureReason = (errorMessage: string): 'token_reused' | 'token_expired' | 'error' => {
  if (errorMessage.includes('already been used')) return 'token_reused';
  if (errorMessage.includes('expired')) return 'token_expired';
  return 'error';
};

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
      const newEmail = user.pendingEmail?.trim().toLowerCase();

      try {
        // Verify the token and complete the email change. The sign-in identity moved, so every
        // session minted under the old one ends in the same transaction; the response already tells
        // the user to sign in again with the new address.
        const outcome = await commitWithSessionEnd(
          req,
          () =>
            userService.verifyEmailChange(
              { token },
              {
                db: {
                  users: {
                    findByPendingEmailToken: async (token: string) => userRepository.findByPendingEmailToken(token),
                    existsOtherUserWithEmail: async (email: string, excludeUserId?: string) =>
                      userRepository.existsOtherUserWithEmail(email, excludeUserId),
                    update: async user => userRepository.update(user),
                  },
                },
              }
            ),
          outcome => (outcome === 'changed' ? { userId: user.id, reason: 'email_changed' } : undefined)
        );
        if (outcome === 'unavailable') throw new ConflictError(userService.EMAIL_NO_LONGER_AVAILABLE_MESSAGE);

        // The change stamps emailVerified, so an account still owed its deferred flat grant gets it
        // here or never. No-op for an untagged account. The new address never passed registerUser's
        // disposable-email gate, so it is applied here. The domain signup grant is deliberately NOT
        // applied, see the note above the invalidation below.
        if (newEmail && (await isEligibleForFreeCredits(newEmail, req.logger))) {
          await releaseVerifiedPendingFreeCredits(user, 'email change (email verified)', req.logger);
        }

        await logAuthAudit(req, {
          userId: user.id,
          event: 'email_change_confirmed',
          metadata: {
            oldEmail: oldEmail || undefined,
            newEmail: newEmail || undefined,
            tokenAge: user.pendingEmailSentAt ? calculateTokenAge(user.pendingEmailSentAt) : undefined,
          },
        });

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
        // (see server/auth/emailVerifiedGrants.ts) are DELIBERATELY not granted on email change -
        // they are strictly a signup-time perk, and gating them here would open an
        // email-swap credit-farming vector. The idempotent `domain-grant-credits:`
        // key means adding it here later (if product wants it) stays safe.
        if (entitlementsForEmail(oldEmail, true).size > 0 || entitlementsForEmail(newEmail, true).size > 0) {
          await pushEntitlementInvalidation(user.id, req.logger);
        }

        return res.json({ message: 'Email changed successfully. Please log in with your new email address.' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await logAuthAudit(req, {
          userId: user.id,
          event: 'email_change_failed',
          metadata: {
            reason: emailChangeFailureReason(errorMessage),
            oldEmail: oldEmail || undefined,
            newEmail: newEmail || undefined,
            tokenAge: user.pendingEmailSentAt ? calculateTokenAge(user.pendingEmailSentAt) : undefined,
            error: errorMessage,
          },
        });
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
