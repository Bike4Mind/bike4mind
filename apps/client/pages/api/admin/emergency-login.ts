import bcrypt from 'bcryptjs';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { resolveSecondFactor } from '@server/auth/signInSecondFactor';
import { mfaService } from '@bike4mind/services';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { z } from 'zod';
import { Resource } from 'sst';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { recordAdminActionForActor, systemAuditActor, toUserActor } from '@server/utils/adminAudit';

const EmergencyLoginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

type EmergencyLoginResponse = {
  mfaRequired: true;
  passkeyAvailable: boolean;
  userId: string;
  /** mfaPending access token: accepted only by the MFA routes. */
  accessToken: string;
};

type MatchedAccount = Parameters<typeof toUserActor>[0];

type EmergencyLoginDenialReason = 'no_password' | 'invalid_password' | 'not_admin' | 'banned' | 'no_second_factor';

// A denied attempt proves no user identity; only an accepted password is attributed to the account.
const auditEmergencyLogin = (
  req: Parameters<typeof recordAdminActionForActor>[0],
  account: MatchedAccount,
  outcome:
    | { action: 'user.emergency_login.challenged' }
    | { action: 'user.emergency_login.denied'; reason: EmergencyLoginDenialReason }
) =>
  recordAdminActionForActor(
    req,
    outcome.action === 'user.emergency_login.denied'
      ? systemAuditActor('emergency-login')
      : toUserActor(account, 'platform'),
    {
      action: outcome.action,
      target: { kind: 'user', id: account.id, displayName: account.email ?? account.username },
      summary:
        outcome.action === 'user.emergency_login.challenged'
          ? 'emergency login password accepted, second factor challenged'
          : `emergency login denied (${outcome.reason})`,
      details: outcome.action === 'user.emergency_login.denied' ? { reason: outcome.reason } : undefined,
    }
  );

const denyEmergencyLogin = async (
  req: Parameters<typeof recordAdminActionForActor>[0],
  account: MatchedAccount,
  reason: EmergencyLoginDenialReason
): Promise<never> => {
  if (account.isAdmin) {
    await auditEmergencyLogin(req, account, { action: 'user.emergency_login.denied', reason });
  }
  throw new UnauthorizedError('Invalid credentials');
};

// Enforce shared BlockedIP list so IPs blocked via the normal auth path cannot bypass via this endpoint
// Rate limit to 5 attempts per 10 minutes to prevent brute force
const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(rateLimit({ limit: 5, windowMs: 10 * 60 * 1000 }))
  .post(
    asyncHandler(async (req, res) => {
      // Use Zod for runtime validation (was type assertion only)
      const { username, password } = EmergencyLoginSchema.parse(req.body);

      // Don't log username to prevent enumeration via CloudWatch logs
      req.logger.info('Emergency login attempt');

      // Find user by username OR email using case-insensitive exact match.
      // Escape regex special characters to prevent injection/ReDoS
      const escapedUsername = escapeRegex(username);
      const user = await User.findOne({
        $or: [
          { username: { $regex: `^${escapedUsername}$`, $options: 'i' } },
          { email: { $regex: `^${escapedUsername}$`, $options: 'i' } },
        ],
      }).select('+password');

      if (!user) {
        // Use generic error, don't reveal whether user exists
        throw new UnauthorizedError('Invalid credentials');
      }

      // Verify password
      if (!user.password) {
        return denyEmergencyLogin(req, user, 'no_password');
      }

      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        return denyEmergencyLogin(req, user, 'invalid_password');
      }

      // Check if user is admin
      if (!user.isAdmin) {
        return denyEmergencyLogin(req, user, 'not_admin');
      }

      // Check if user is banned
      if (user.isBanned) {
        return denyEmergencyLogin(req, user, 'banned');
      }

      // Break-glass access still needs the account's own second factor: the password alone must
      // never yield an admin session. An admin without one is refused outright rather than
      // offered enrollment, which would let a password-holder enroll their own authenticator.
      // The response stays generic; the reason is in the log for the operator.
      if (!mfaService.userHasMFAConfigured(user)) {
        req.logger.warn('Emergency login refused: account has no second factor enrolled', { userId: user.id });
        return denyEmergencyLogin(req, user, 'no_second_factor');
      }
      // A remembered device never skips it here, so the outcome is always a challenge.
      const secondFactor = await resolveSecondFactor(req, user, {
        origin: { strategy: 'local', createdVia: 'emergency' },
        honourTrustedDevice: false,
      });
      if (secondFactor.kind !== 'challenge') {
        throw new Error(`Emergency login expected an MFA challenge, got ${secondFactor.kind}`);
      }

      // Log emergency access for audit trail - minimal info only
      req.logger.warn('EMERGENCY ADMIN ACCESS: password accepted, second factor pending', {
        userId: user.id,
        ipAddress: getClientIp(req),
        source: 'emergency-login',
      });

      // The full session is minted by /api/auth/mfa/verify (or the passkey route) once the
      // second factor is proven, as for any other sign-in.
      const response: EmergencyLoginResponse = {
        mfaRequired: true,
        passkeyAvailable: secondFactor.passkeyAvailable,
        userId: user.id,
        accessToken: secondFactor.mfaToken,
      };

      // Written before the pending token leaves the server: a failed audit write denies the login.
      await auditEmergencyLogin(req, user, { action: 'user.emergency_login.challenged' });

      res.setHeader('X-Emergency-Access', 'true');
      res.setHeader('X-Access-Timestamp', new Date().toISOString());

      return res.status(200).json(response);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

// Gate behind SST feature flag: returns 404 by default so the route is not
// discoverable unless explicitly enabled.
// To enable: npx sst secret set EMERGENCY_LOGIN_ENABLED "true" --stage <env>
let emergencyLoginEnabled = false;
try {
  emergencyLoginEnabled = Resource.EMERGENCY_LOGIN_ENABLED.value === 'true';
} catch {
  // Secret not configured - treat as disabled (fail-safe closed)
}

export default emergencyLoginEnabled
  ? handler
  : (_req: import('next').NextApiRequest, res: import('next').NextApiResponse) => res.status(404).end();
