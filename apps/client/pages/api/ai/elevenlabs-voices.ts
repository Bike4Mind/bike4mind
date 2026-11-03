/**
 * GET /api/ai/elevenlabs-voices - the ElevenLabs voices this caller can synthesize with, for Studio's
 * voice picker. Read with the same key /api/ai/tts would use (the caller's own, else the admin one),
 * so the list matches the account doing the synthesis. A caller without a key of their own therefore
 * sees the admin workspace's catalog; only id, name, labels and preview URL leave the server.
 * Unlike /api/v1/voice/voices (the admin voice agent catalog) it does not depend on the
 * voiceV2Enabled setting.
 *
 * Unversioned and unpublished: only Studio's picker reads it, so API keys never need it (jwtOnly).
 * No key is not an error here: an empty list sends the picker to its account-voice fallback.
 */
import { fetchElevenLabsVoices } from '@bike4mind/voice';
import { baseApi } from '@server/middlewares/baseApi';
import { BadGatewayError } from '@bike4mind/server-utils/utils/errors';
import { getTtsProviderKey } from '@server/utils/resolveTtsProvider';

const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const apiKey = await getTtsProviderKey('elevenlabs', req.user!.id);
  if (!apiKey) return res.json({ voices: [] });

  try {
    return res.json({ voices: await fetchElevenLabsVoices(apiKey) });
  } catch (error) {
    // The upstream message can echo provider internals, so it stays in the log, not the body.
    req.logger.error({ err: error }, '[elevenlabs-voices] failed to fetch ElevenLabs voices');
    throw new BadGatewayError('Failed to fetch ElevenLabs voices');
  }
});

export default handler;
