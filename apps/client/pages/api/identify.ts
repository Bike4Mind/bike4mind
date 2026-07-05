import { requireUser } from '@server/middlewares/requireUser';
import { baseApi } from '@server/middlewares/baseApi';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { dayjs } from '@bike4mind/common';
import { authTokenGenerator } from '@server/auth/tokenGenerator';

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
      ({ accessToken, refreshToken } = authTokenGenerator.createAccessToken(req.user?.id, req.user?.tokenVersion ?? 0));
    } else {
      const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
      let previousSecret = undefined;
      // If JWT_SECRET was just recently renewed within 24 hours, allow the user to continue using the old key
      if (dayjs(secretRotation?.rotatedAt).isBefore(dayjs().add(1, 'day'))) {
        previousSecret = secretRotation?.previousKey;
      }
      const decoded = authTokenGenerator.verifyToken(accessToken, previousSecret);
      if (decoded.exp && decoded.exp < Date.now() / 1000) {
        ({ accessToken, refreshToken } = authTokenGenerator.createAccessToken(
          req.user?.id,
          req.user?.tokenVersion ?? 0
        ));
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
