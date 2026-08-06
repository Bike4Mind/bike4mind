import {
  ApiKeyType,
  AudioGenerationToolCall,
  extensionFromMimeType,
  KnowledgeType,
  SOUND_EFFECTS_MAX_INPUT_CHARS,
  SoundGenerationVendor,
  TTS_MAX_INPUT_CHARS,
  VoiceGenerationVendor,
} from '@bike4mind/common';
import { aiSoundService, aiVoiceService } from '@bike4mind/utils';
import { v4 as uuidv4 } from 'uuid';
import { getEffectiveApiKey } from '../../../../apiKeyService';
import { persistGeneratedFileAsFabFile } from '../../helpers/persistGeneratedFile';
import { ToolContext, ToolDefinition } from '../../base/types';

const DEFAULT_TTS_PROVIDER: VoiceGenerationVendor = 'openai';
// Sound effects have a single provider today; the vendor factory (aiSoundService)
// is open for more.
const SFX_PROVIDER: SoundGenerationVendor = 'elevenlabs';

/** Generic, non-leaking message when a required provider key is not configured. */
const UNAVAILABLE_MESSAGE = 'Error: Audio generation is currently unavailable. Please try again later.';

const ttsApiKeyType = (provider: VoiceGenerationVendor): ApiKeyType =>
  provider === 'elevenlabs' ? ApiKeyType.elevenlabs : ApiKeyType.openai;

/**
 * In-chat / agent TTS + sound-effects generation, modeled on image_generation and
 * music_generation. A second entry point (not a second config) to the direct-action
 * Generate Audio UI from #1055/PR #1183: it consumes the same `useAudioGenSettings`
 * selections (threaded in as `audioConfig`), the same provider services, and the same
 * per-character (speech) / per-duration (sound effect) cost model as the direct endpoints.
 *
 * The model picks the `kind` (speech vs sound effect) and supplies the text; provider,
 * voice, format and duration default from `audioConfig` so the user never has to pick an
 * "audio model." Billing settles on delivery (onFinish) - the failure paths return before
 * then, so an undelivered clip is never billed - reserving into the host's toolCreditsMap
 * for end-of-quest settlement (see ToolBuilder + ChatCompletionProcess). The clip is
 * uploaded to the generated-content bucket and pushed onto `quest.images` (the client
 * splits by extension so audio renders as an inline player), with a browsable AUDIO copy
 * kept in the Knowledge Base (best-effort).
 */
export const audioGenerationTool: ToolDefinition = {
  name: 'audio_generation',
  implementation: (context, config: AudioGenerationToolCall) => ({
    toolFn: async val => {
      const audioConfig = config ?? {};
      const {
        kind,
        text,
        durationSeconds: toolDurationSeconds,
      } = val as { kind?: string; text?: string; durationSeconds?: number };

      if (!text || !text.trim()) {
        return 'Error: audio_generation requires non-empty text.';
      }

      // Anything that is not explicitly a sound effect is speech (the common case),
      // so a caller that omits `kind` still gets a sensible result.
      const isSoundEffect = kind === 'sound_effect';

      if (isSoundEffect) {
        // Reject over-length input before any paid provider call, matching the bound the
        // direct /api/ai/sound-effects endpoint enforces (soundGeneration.ts). A crafted
        // caller could otherwise round-trip an oversized prompt to the vendor.
        if (text.length > SOUND_EFFECTS_MAX_INPUT_CHARS) {
          return `Error: sound-effect description too long (max ${SOUND_EFFECTS_MAX_INPUT_CHARS} characters).`;
        }

        // Resolve the provider key BEFORE the affordability gate so a keyless, low-credit
        // caller learns the actionable problem (missing key) instead of "insufficient credits".
        const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.elevenlabs }, { db: context.db });
        if (!apiKey) {
          context.logger.error('[audio_generation] ElevenLabs API key is not configured; refusing to dispatch');
          return UNAVAILABLE_MESSAGE;
        }

        const durationSeconds = toolDurationSeconds ?? audioConfig.durationSeconds ?? undefined;

        // Affordability gate only (onStart): the host throws insufficient_credits here before
        // the paid provider call. The charge itself is reserved in onFinish so a failed
        // generation is never billed.
        await context.onStart?.('audio_generation', {
          kind: 'sound_effect',
          provider: SFX_PROVIDER,
          durationSeconds,
        });

        await context.statusUpdate({}, 'Generating sound effect...');

        let audio: Buffer;
        let contentType: string;
        try {
          ({ audio, contentType } = await aiSoundService(SFX_PROVIDER, apiKey, context.logger).generate(text, {
            durationSeconds,
            promptInfluence: audioConfig.promptInfluence,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          context.logger.error(`[audio_generation] sound-effect generation failed: ${message}`);
          return `Error: ${message}`;
        }

        const storedPath = await persistAndUpload(context, audio, contentType, 'sound-effect');

        await context.onFinish?.('audio_generation', {
          kind: 'sound_effect',
          provider: SFX_PROVIDER,
          durationSeconds,
          paths: [storedPath],
        });
        await context.statusUpdate({ images: [storedPath] });
        return 'Successfully generated sound effect';
      }

      // Speech (text-to-speech). serverConfig gates audio_generation on OpenAI OR ElevenLabs,
      // so a user can have only one key while their saved ttsProvider names the other (e.g. an
      // ElevenLabs-only user whose default is still openai). Fall back to whichever provider the
      // user actually has a key for instead of hard-failing. Voices are provider-specific, so a
      // fallback drops the configured voice and lets the fallback provider use its default.
      let provider = audioConfig.ttsProvider ?? DEFAULT_TTS_PROVIDER;
      let voice = audioConfig.voice || undefined;
      let apiKey = await getEffectiveApiKey(context.userId, { type: ttsApiKeyType(provider) }, { db: context.db });
      if (!apiKey) {
        const fallbackProvider: VoiceGenerationVendor = provider === 'elevenlabs' ? 'openai' : 'elevenlabs';
        const fallbackKey = await getEffectiveApiKey(
          context.userId,
          { type: ttsApiKeyType(fallbackProvider) },
          { db: context.db }
        );
        if (!fallbackKey) {
          context.logger.error('[audio_generation] no TTS provider key is configured; refusing to dispatch');
          return UNAVAILABLE_MESSAGE;
        }
        context.logger.warn(
          `[audio_generation] ${provider} key not configured; falling back to ${fallbackProvider} for speech (provider default voice)`
        );
        provider = fallbackProvider;
        voice = undefined;
        apiKey = fallbackKey;
      }

      // Reject over-length input before the paid call, per the resolved provider's cap.
      if (text.length > TTS_MAX_INPUT_CHARS[provider]) {
        return `Error: text too long for ${provider} speech (max ${TTS_MAX_INPUT_CHARS[provider]} characters).`;
      }

      // Gate on the input character count with a conservative (highest-rate) estimate:
      // the resolved model isn't known until after synthesis, so onFinish settles the
      // exact charge from the provider result. Over-estimating here fails toward the
      // safe side (never a free call).
      await context.onStart?.('audio_generation', {
        kind: 'speech',
        provider,
        characters: text.length,
      });

      await context.statusUpdate({}, 'Generating speech...');

      let audio: Buffer;
      let contentType: string;
      let resolvedModel: string;
      let characters: number;
      try {
        ({
          audio,
          contentType,
          model: resolvedModel,
          characters,
        } = await aiVoiceService(provider, apiKey, context.logger).synthesize(text, {
          voice,
          format: audioConfig.format,
          language: provider === 'elevenlabs' && audioConfig.languageCode ? audioConfig.languageCode : undefined,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        context.logger.error(`[audio_generation] speech generation failed: ${message}`);
        return `Error: ${message}`;
      }

      const storedPath = await persistAndUpload(context, audio, contentType, 'speech');

      // Settle on the ACTUAL billed model + character count so the tool charge matches
      // the direct /api/ai/tts endpoint exactly (deductTtsCredits).
      await context.onFinish?.('audio_generation', {
        kind: 'speech',
        provider,
        model: resolvedModel,
        characters,
        paths: [storedPath],
      });
      await context.statusUpdate({ images: [storedPath] });
      return 'Successfully generated speech';
    },
    toolSchema: {
      name: 'audio_generation',
      description:
        '🔊 AUDIO GENERATION TOOL: Generate spoken audio (text-to-speech) or a short sound effect from text. Use kind="speech" when the user wants something read aloud / narrated / voiced ("say this", "read this out loud", "narrate", "voice this"). Use kind="sound_effect" for a short non-speech sound described in words ("a dog barking", "rain on a tin roof", "a whoosh"). Do NOT use this for music or songs (that is music_generation). Voice, provider and format come from the user\'s saved audio settings; just pass the text.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['speech', 'sound_effect'],
            description: 'speech = read the text aloud (TTS); sound_effect = generate the described sound.',
          },
          text: {
            type: 'string',
            description:
              'For speech: the exact words to speak. For a sound effect: a short description of the sound to generate.',
          },
          durationSeconds: {
            type: 'number',
            description:
              'Sound-effect length in seconds (0.5-30). Ignored for speech; omit to let the provider choose.',
            minimum: 0.5,
            maximum: 30,
          },
        },
        additionalProperties: false,
        required: ['kind', 'text'],
      },
    },
  }),
};

/**
 * Upload the clip to the generated-content bucket (CDN-served, rides quest.images for
 * inline playback) and keep a browsable AUDIO copy in the Knowledge Base (best-effort).
 * Returns the generated-content storage path.
 */
async function persistAndUpload(
  context: ToolContext,
  audio: Buffer,
  contentType: string,
  source: 'speech' | 'sound-effect'
): Promise<string> {
  const ext = extensionFromMimeType(contentType) || 'mp3';
  const filename = `${uuidv4()}.${ext}`;

  // Pass ContentType so S3 serves audio/* and the browser <audio> element can play it.
  // Always kept - this is what the inline player streams.
  const storedPath = await context.imageGenerateStorage.upload(audio, filename, { ContentType: contentType });

  // Keep a browsable AUDIO copy in the Knowledge Base, honoring the user's
  // saveGeneratedAudio preference - the same gate the direct /api/ai/tts and
  // sound-effects endpoints apply (defaults on). AUDIO type so the file is never
  // chunked/vectorized/attached to a completion.
  if (context.user?.preferences?.saveGeneratedAudio ?? true) {
    await persistGeneratedFileAsFabFile(context, {
      fileName: `generated-${source}-${filename.slice(0, 8)}.${ext}`,
      mimeType: contentType,
      content: audio,
      type: KnowledgeType.AUDIO,
      tags: [
        { name: 'generated', strength: 1 },
        { name: source, strength: 1 },
      ],
    });
  }

  return storedPath;
}
