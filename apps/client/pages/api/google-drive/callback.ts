import { BadRequestError } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { getTokens, GOOGLE_DRIVE_STATE_OPTIONS } from '@server/integrations/google/drive/common';
import { encryptToken } from '@server/security/tokenEncryption';
import { verifyStateToken, type BaseStatePayload } from '@server/auth/jwtStateStore';
import { readStateNonceHash, clearStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { GOOGLE_DRIVE_CONNECT_ERROR } from '@client/shared/googleDriveConnectErrors';
import type { Request } from 'express';

/**
 * Google's token endpoint fails with a GaxiosError carrying its own `.status`, which errorHandler
 * forwards verbatim - so an upstream 401 (e.g. `invalid_client`) would reach the SPA as the
 * code-less 401 that logs the user out. Rethrow every exchange failure as a coded 400.
 */
async function exchangeCode(req: Request, code: string) {
  try {
    return await getTokens(code);
  } catch (error) {
    req.logger.warn('Google Drive token exchange failed', error);
    throw new BadRequestError('Google Drive could not complete the connection.', {
      code: GOOGLE_DRIVE_CONNECT_ERROR.failed,
    });
  }
}

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { code?: string; state?: string }>(async (req, res) => {
    const { code, state } = req.query;
    const { user } = req;

    // Burn the nonce on EVERY exit (invalid state, identity mismatch, a throwing
    // token exchange or DB write, or success) so a stale slot never lingers.
    try {
      // Bind completion to the browser that started the flow: the state's `nh` claim
      // must match this browser's nonce cookie. Fails closed (no state / no cookie).
      const stateResult = verifyStateToken<BaseStatePayload & { userId?: string }>(
        state as string,
        GOOGLE_DRIVE_STATE_OPTIONS,
        readStateNonceHash(req, NONCE_SLOT.driveConnect)
      );
      // A failed connect answers 400 + a code, never a 401: ApiContext treats a code-less 401
      // as a dead login session, and the post-login redirectTo would replay this callback forever.
      // Throw rather than write the response here, so the finally clears the nonce cookie before
      // errorHandler ends the response.
      if (!stateResult.valid) {
        const code =
          stateResult.reason === 'expired' ? GOOGLE_DRIVE_CONNECT_ERROR.expired : GOOGLE_DRIVE_CONNECT_ERROR.invalid;
        throw new BadRequestError(stateResult.message, { code });
      }
      // Defense-in-depth beyond the browser binding: the tokens must land on the
      // account that started the flow, not whoever the completion request is authed
      // as, in case the session changed between flow start and completion.
      if (stateResult.payload.userId !== user.id) {
        throw new BadRequestError('Invalid authorization state.', { code: GOOGLE_DRIVE_CONNECT_ERROR.invalid });
      }

      const tokens = await exchangeCode(req, code as string);
      await User.findByIdAndUpdate(user.id, {
        $set: {
          googleDrive: {
            accessToken: encryptToken(tokens.access_token!)!,
            refreshToken: tokens.refresh_token ? encryptToken(tokens.refresh_token)! : undefined,
            expiresAt: new Date(tokens.expiry_date!),
          },
        },
      });
    } finally {
      clearStateNonce(res, NONCE_SLOT.driveConnect);
    }
    // Sent after the finally: send() ends the response, so a Set-Cookie from inside it would throw.
    return res.status(204).send();
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
