import { ApiKeyType } from '@bike4mind/common';
import { apiKeyRepository, voiceRepository } from '@bike4mind/database';
import { apiKeyService, voiceService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

// This api checks if the user is ready for voice feature
const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;

    let ready: boolean = false;
    try {
      const [apiKey, voiceId] = await Promise.all([
        apiKeyService
          .getApiKey(userId, { type: ApiKeyType.elevenlabs }, { db: { apiKeys: apiKeyRepository } })
          .then(key => key?.apiKey ?? null),
        voiceService.getVoiceId(userId, { db: { voices: voiceRepository } }),
      ]);

      if (apiKey && voiceId) ready = true;
    } catch (e) {
      // do nothing
    }

    return res.status(200).json({ ready });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
