import { AuthTokenGeneratorService } from '@bike4mind/auth';
import { Config } from '@server/utils/config';

export const authTokenGenerator = new AuthTokenGeneratorService({
  accessTokenSecret: Config.JWT_SECRET,
  refreshTokenSecret: Config.JWT_SECRET,
  accessTokenExpiresIn: '7d',
  refreshTokenExpiresIn: '30d',
});
