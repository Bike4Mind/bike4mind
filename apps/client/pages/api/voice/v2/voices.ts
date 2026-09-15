import { adminSettingsRepository } from '@bike4mind/database';
import { ForbiddenError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { fetchElevenLabsVoices } from '@bike4mind/voice';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (req, res) => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['voiceV2Enabled', 'elevenLabsServerApiKey'] }
  );

  if (!getSettingsValue('voiceV2Enabled', settings)) {
    throw new ForbiddenError('Voice v2 is not enabled');
  }

  const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
  if (!apiKey) {
    return res.status(500).json({
      error: 'ElevenLabs server API key must be configured in admin settings',
    });
  }

  try {
    const voices = await fetchElevenLabsVoices(apiKey);
    return res.status(200).json({ voices });
  } catch (error) {
    req.logger.error({ err: error }, '[voice-v2/voices] failed to fetch ElevenLabs voices');
    const detail = error instanceof Error ? error.message : String(error);
    return res.status(502).json({ error: 'Failed to fetch ElevenLabs voices', detail });
  }
});

export default handler;
