/**
 * GET /api/v1/voice/voices - the ElevenLabs workspace voice catalog. Also served at the legacy
 * `/api/voice/v2/voices` (pages/api/voice/v2/voices.ts re-exports this), which the admin Voice
 * Settings picker calls. Auth mode and the `ai:generate` scope come from `listVoicesContract`.
 */
import { adminSettingsRepository } from '@bike4mind/database';
import { listVoicesContract } from '@bike4mind/common';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { fetchElevenLabsVoices } from '@bike4mind/voice';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { BadGatewayError, ForbiddenError, HTTPError } from '@server/utils/errors';

const handler = nextRouteForContract(listVoicesContract).get(async (req, res) => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['voiceV2Enabled', 'elevenLabsServerApiKey'] }
  );

  if (!getSettingsValue('voiceV2Enabled', settings)) {
    throw new ForbiddenError('Voice v2 is not enabled');
  }

  const apiKey = getSettingsValue('elevenLabsServerApiKey', settings);
  if (!apiKey) {
    throw new HTTPError(503, 'ElevenLabs server API key must be configured in admin settings', {
      errorCode: 'provider_not_configured',
    });
  }

  try {
    const voices = await fetchElevenLabsVoices(apiKey);
    return res.status(200).json({ voices });
  } catch (error) {
    // The upstream message can echo provider internals, so it stays in the log, not the body.
    req.logger.error({ err: error }, '[voice-v2/voices] failed to fetch ElevenLabs voices');
    throw new BadGatewayError('Failed to fetch ElevenLabs voices');
  }
});

export default handler;
