import { baseApi } from '@server/middlewares/baseApi';
import {
  ttsRequestSchema,
  TTS_MAX_INPUT_CHARS,
  UnprocessableEntityError,
  VoiceGenerationVendor,
} from '@bike4mind/common';
import { aiVoiceService } from '@bike4mind/utils';
import { resolveTtsProvider, TtsProviderNotConfiguredError } from '@server/utils/resolveTtsProvider';
import { exceedsTtsResponseLimit, TTS_RESPONSE_TOO_LARGE_MESSAGE } from '@server/utils/ttsResponseLimit';

const DEFAULT_PROVIDER: VoiceGenerationVendor = 'openai';

/**
 * Unified, multi-provider Text-to-Speech endpoint (#724).
 *
 * Body: { text, provider?, model?, voice?, format?, encoding?, stability?, similarityBoost? }
 * - provider defaults to openai; model/voice/format fall back to per-provider defaults.
 * - encoding 'binary' (default) streams raw audio bytes with an audio/* Content-Type;
 *   'base64' returns JSON { audio, format, contentType }.
 *
 * Mirrors the multi-vendor image API (aiImageService). The legacy
 * /api/ai/text-to-speech and /api/elabs/text-to-speech routes remain as thin
 * adapters over the same aiVoiceService abstraction.
 */
const handler = baseApi().post(async (req, res) => {
  const { text, provider, model, voice, format, encoding, stability, similarityBoost } = ttsRequestSchema.parse(
    req.body
  );

  const vendor = provider ?? DEFAULT_PROVIDER;

  const maxChars = TTS_MAX_INPUT_CHARS[vendor];
  if (text.length > maxChars) {
    throw new UnprocessableEntityError(
      `Input exceeds the ${vendor} limit of ${maxChars} characters (got ${text.length})`
    );
  }

  let resolved;
  try {
    resolved = await resolveTtsProvider({
      provider: vendor,
      userId: req.user?.id,
      requestedVoice: voice,
      preferredVoice: req.user?.preferredVoice,
    });
  } catch (error) {
    if (error instanceof TtsProviderNotConfiguredError) {
      return res.status(401).json({ error: error.message });
    }
    throw error;
  }

  try {
    const result = await aiVoiceService(vendor, resolved.apiKey, req.logger).synthesize(text, {
      voice: resolved.voice,
      model,
      format,
      stability,
      similarityBoost,
    });

    // Serverless response-size guard: a buffered audio body over ~4MB exceeds the
    // Lambda/API Gateway payload cap and would fail as an opaque CloudFront 502.
    if (exceedsTtsResponseLimit(result.audio.length)) {
      return res.status(413).json({ error: TTS_RESPONSE_TOO_LARGE_MESSAGE, provider: vendor });
    }

    if (encoding === 'base64') {
      return res.json({
        audio: result.audio.toString('base64'),
        format: result.format,
        contentType: result.contentType,
      });
    }

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', result.audio.length);
    return res.send(result.audio);
  } catch (error) {
    // Pass through client-actionable upstream errors (bad voice/param, invalid
    // key, rate limit) with a generic body so the provider's raw error text
    // never leaks; treat everything else as an upstream (502) failure.
    const status = (error as { status?: number })?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return res.status(status).json({ error: `TTS request rejected by the ${vendor} provider`, provider: vendor });
    }
    req.logger.error('TTS synthesis failed', { error, provider: vendor });
    return res.status(502).json({ error: 'Failed to generate speech', provider: vendor });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
