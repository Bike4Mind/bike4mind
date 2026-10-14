import bcrypt from 'bcryptjs';
import { User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { UnauthorizedError } from '@server/utils/errors';
import { resolveSecondFactor } from '@server/auth/signInSecondFactor';
import { mfaService } from '@bike4mind/services';
import { rateLimit } from '@server/middlewares/rateLimit';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { z } from 'zod';
import { Resource } from 'sst';

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
        throw new UnauthorizedError('Invalid credentials');
      }

      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        throw new UnauthorizedError('Invalid credentials');
      }

      // Check if user is admin
      if (!user.isAdmin) {
        throw new UnauthorizedError('Invalid credentials');
      }

      // Check if user is banned
      if (user.isBanned) {
        throw new UnauthorizedError('Invalid credentials');
      }

      // Break-glass access still needs the account's own second factor: the password alone must
      // never yield an admin session. An admin without one is refused outright rather than
      // offered enrollment, which would let a password-holder enroll their own authenticator.
      // The response stays generic; the reason is in the log for the operator.
      if (!mfaService.userHasMFAConfigured(user)) {
        req.logger.warn('Emergency login refused: account has no second factor enrolled', { userId: user.id });
        throw new UnauthorizedError('Invalid credentials');
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
        ipAddress: req.ip || req.connection.remoteAddress,
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
