import { apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id;

  const apiKeys = await apiKeyService.listOwnApiKeys(
    userId,
    {
      db: {
        apiKeys: apiKeyRepository,
      },
    },
    {
      obfuscate: true,
    }
  );

  return res.json(apiKeys);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
