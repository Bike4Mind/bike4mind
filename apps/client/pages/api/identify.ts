import { requireUser } from '@server/middlewares/requireUser';
import { baseApi } from '@server/middlewares/baseApi';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';

const handler = baseApi()
  .use(requireUser)
  .get(async (req, res) => {
    let accessToken: string | undefined = req.headers?.authorization?.split(' ')[1];
    req.logger.log(
      `Successful auth for "${req.user?.username}" (${req.user?.email}), ${
        accessToken ? 'have' : 'creating'
      } access token`
    );

    let refreshToken: string | undefined;
    if (!accessToken) {
      ({ accessToken, refreshToken } = await issueSessionForRequest(req, req.user!.id, {
        createdVia: 'identify',
        tokenVersion: req.user!.tokenVersion ?? 0,
      }));
    } else {
      const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
      let previousSecret = undefined;
      // Accept the previous key only within the shared rotation grace window.
      if (isRotatedSecretWithinGraceWindow(secretRotation?.rotatedAt)) {
        previousSecret = secretRotation?.previousKey;
      }
      const decoded = authTokenGenerator.verifyToken(accessToken, previousSecret);
      if (decoded.exp && decoded.exp < Date.now() / 1000) {
        ({ accessToken, refreshToken } = await issueSessionForRequest(req, req.user!.id, {
          createdVia: 'identify',
          tokenVersion: req.user!.tokenVersion ?? 0,
        }));
      }
    }

    return res.status(200).json({
      user: req.user,
      accessToken,
      refreshToken,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
