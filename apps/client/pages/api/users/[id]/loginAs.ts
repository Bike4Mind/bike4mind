import { adminService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { userRepository, withTransaction, SupportAccess } from '@bike4mind/database';
import { impersonationLifetimeMs } from '@server/auth/impersonation';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { readRefreshCookie, setAdminReturnCookie, setRefreshCookie } from '@bike4mind/server-utils/auth/refreshCookie';
import { UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError } from '@bike4mind/utils';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { selfSessionResponseSchema } from '@server/auth/selfSessionResponseSchema';
import {
  denySelfAdminAction,
  isSameUserId,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';

// jwtOnly: impersonation mints a full session, so an API key must never reach it
// (see sessionGrantRoutesRejectApiKeys.test.ts).
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const targetUserId = req.query.id;
    const adminUser = req.user;

    const { mfaToken, reason: rawReason } = req.body as { mfaToken?: string; reason?: unknown };

    if (!mfaToken || typeof mfaToken !== 'string') {
      throw new BadRequestError('MFA token is required to use loginAs');
    }

    if (adminUser.isAdmin && isSameUserId(adminUser.id, targetUserId)) {
      await denySelfAdminAction(req, {
        action: 'user.impersonation.denied',
        attempted: 'user.impersonation.started',
        target: { kind: 'user', id: targetUserId, displayName: adminUser.name || adminUser.username },
      });
    }

    const reason = parseAdminActionReason(rawReason);

    // Capture the admin's own refresh token BEFORE the impersonated one overwrites the cookie
    // slot; it is parked in the return cookie so /api/auth/returnToAdmin can restore the admin
    // session. Without it there is no way back, so refuse to start rather than strand the admin
    // (a caller with no refresh cookie is not a browser session - e.g. an API key).
    const adminRefreshToken = readRefreshCookie(req);
    if (!adminRefreshToken) {
      throw new UnauthorizedError('loginAs requires an interactive browser session');
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

    // Mint a full session for the impersonated user; its refresh token takes over the primary
    // cookie. The refresh token must belong to the target - if the browser kept the admin's,
    // the first 401-triggered refresh would mint an admin access token and silently flip the
    // session back to the admin mid-impersonation.
    //
    // Stamp an impersonatedBy claim so downstream can tell a real customer session from an
    // admin-driven one. Per-device /api/logout now revokes only this session's own `sid` (never a
    // tokenVersion bump), so logging out mid-impersonation kills just the impersonation session and
    // leaves the real customer's devices untouched; and the session-management endpoints
    // (revoke-others / the admin force-logout) refuse to run while this claim is present, so an
    // admin can't sign the customer's other devices out from an impersonated session.
    //
    // The session doc and the started entry commit together; the sid groups everything done in
    // this impersonation. Cookies are written only after the commit.
    const { accessToken, refreshToken } = await withTransaction(async () => {
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + impersonationLifetimeMs());
      const session = await issueSessionForRequest(req, targetUser.id, {
        createdVia: 'impersonation',
        tokenVersion: targetUser.tokenVersion ?? 0,
        impersonatedBy: adminUser.id,
        impersonationExpiresAt: expiresAt,
      });
      await SupportAccess.create([
        { sid: session.sid, userId: targetUser.id, adminId: adminUser.id, reason, startedAt, expiresAt },
      ]);
      await recordAdminActionFromRequest(req, {
        action: 'user.impersonation.started',
        target: {
          kind: 'user',
          id: targetUser.id,
          displayName: targetUser.name || targetUser.username || targetUser.email || targetUser.id,
        },
        summary: 'started impersonating the user',
        reason,
        details: { expiresAt: expiresAt.toISOString(), readOnly: true, escalated: false },
        related: { impersonationSessionId: session.sid },
      });
      return session;
    });
    setRefreshCookie(res, refreshToken);
    setAdminReturnCookie(res, adminRefreshToken);

    return respond(res, selfSessionResponseSchema, {
      user: redactUserSecretsForSelf(targetUser),
      accessToken,
      impersonating: true,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
