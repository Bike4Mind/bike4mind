import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { getTokens, GOOGLE_DRIVE_STATE_OPTIONS } from '@server/integrations/google/drive/common';
import { encryptToken } from '@server/security/tokenEncryption';
import { verifyStateToken } from '@server/auth/jwtStateStore';
import { readStateNonceHash, clearStateNonce } from '@server/auth/oauthFlowCookie';
import { UnauthorizedError } from '@server/utils/errors';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown, { code?: string; state?: string }>(async (req, res) => {
    const { code, state } = req.query;
    const { user } = req;

    // Bind completion to the browser that started the flow: the state's `nh` claim
    // must match this browser's nonce cookie. Fails closed (no state / no cookie).
    const stateResult = verifyStateToken(state as string, GOOGLE_DRIVE_STATE_OPTIONS, readStateNonceHash(req));
    if (!stateResult.valid) {
      clearStateNonce(res);
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
    clearStateNonce(res);
    return res.status(204).send();
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
