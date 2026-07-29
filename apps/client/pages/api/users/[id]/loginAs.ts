import { adminService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository } from '@bike4mind/database';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { BadRequestError } from '@bike4mind/utils';
import { redactUserSecretsForSelf } from '@bike4mind/common';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const targetUserId = req.query.id;
    const adminUser = req.user;

    const { mfaToken } = req.body as { mfaToken?: string };

    if (!mfaToken || typeof mfaToken !== 'string') {
      throw new BadRequestError('MFA token is required to use loginAs');
    }

    const targetUser = await adminService.loginAs(
      adminUser,
      { targetUserId, mfaToken: mfaToken.trim() },
      {
        db: {
          users: userRepository,
        },
        notify: {
          send: async targetUser => {
            req.logger.info(
              `Admin ${adminUser.name}[${adminUser.email}] logged in as user ${targetUser.name}[${targetUser.email}]`
            );
          },
        },
      }
    );

    // Mint a full token PAIR for the impersonated user. The refresh token must
    // belong to the target - if the client kept the admin's refresh token, the
    // first 401-triggered refresh would mint an admin access token and silently
    // flip the session back to the admin mid-impersonation.
    //
    // Stamp an impersonatedBy claim so downstream can tell a real customer session
    // from an admin-driven one: /api/logout skips the tokenVersion revoke for these,
    // otherwise an admin clicking "Log Out" mid-impersonation would force-log-out the
    // real customer on every device.
    const { accessToken, refreshToken } = authTokenGenerator.createAccessToken(
      targetUser.id,
      targetUser.tokenVersion ?? 0,
      { impersonatedBy: adminUser.id }
    );

    return res.json({ user: redactUserSecretsForSelf(targetUser), accessToken, refreshToken });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
