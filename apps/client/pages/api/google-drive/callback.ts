import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { getTokens, GOOGLE_DRIVE_STATE_OPTIONS } from '@server/integrations/google/drive/common';
import { encryptToken } from '@server/security/tokenEncryption';
import { verifyStateToken, type BaseStatePayload } from '@server/auth/jwtStateStore';
import { readStateNonceHash, clearStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { UnauthorizedError } from '@server/utils/errors';

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
      if (!stateResult.valid) {
        throw new UnauthorizedError('Invalid authorization state.');
      }
      // Defense-in-depth beyond the browser binding: the tokens must land on the
      // account that started the flow, not whoever the completion request is authed
      // as, in case the session changed between flow start and completion.
      if (stateResult.payload.userId !== user.id) {
        throw new UnauthorizedError('Invalid authorization state.');
      }

      const tokens = await getTokens(code as string);
      await User.findByIdAndUpdate(user.id, {
        $set: {
          googleDrive: {
            accessToken: encryptToken(tokens.access_token!)!,
            refreshToken: tokens.refresh_token ? encryptToken(tokens.refresh_token)! : undefined,
            expiresAt: new Date(tokens.expiry_date!),
          },
        },
      });
      return res.status(204).send();
    } finally {
      clearStateNonce(res, NONCE_SLOT.driveConnect);
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
