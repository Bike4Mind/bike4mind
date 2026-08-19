import {
  ApiKeyType,
  DEFAULT_MUSIC_LENGTH_MS,
  DEFAULT_MUSIC_MODEL_ID,
  extensionFromMimeType,
  KnowledgeType,
  MAX_MUSIC_LENGTH_MS,
  MIN_MUSIC_LENGTH_MS,
  MusicGenerationVendor,
} from '@bike4mind/common';
import { aiMusicService } from '@bike4mind/utils';
import { v4 as uuidv4 } from 'uuid';
import { getEffectiveApiKey } from '../../../../apiKeyService';
import { persistGeneratedFileAsFabFile } from '../../helpers/persistGeneratedFile';
import { ToolDefinition } from '../../base/types';

// Single provider for now; the vendor factory (aiMusicService) is open for more.
const PROVIDER: MusicGenerationVendor = 'elevenlabs';

/**
 * In-chat / agent background-music generation, modeled on image_generation.
 *
 * Billing is deterministic and length-driven: `onStart` is an up-front affordability
 * gate (the host throws insufficient_credits before the paid provider call), and
 * `onFinish` reserves the charge into the host's toolCreditsMap for end-of-quest
 * settlement (see ToolBuilder + ChatCompletionProcess). Reserving on success rather
 * than on start means a failed generation is never billed. The track is
 * uploaded to the generated-content bucket and pushed into `quest.images` (which
 * the client already treats as "every file a tool produced this turn"); the client
 * splits by extension so audio renders as an inline player. A browsable AUDIO copy
 * is also kept in the Knowledge Base (best-effort).
 */
export const musicGenerationTool: ToolDefinition = {
  name: 'music_generation',
  implementation: context => ({
    toolFn: async val => {
      const {
        prompt,
        lengthMs: requestedLengthMs,
        forceInstrumental,
      } = val as {
        prompt?: string;
        lengthMs?: number;
        forceInstrumental?: boolean;
      };

      if (!prompt || !prompt.trim()) {
        return 'Error: a non-empty music prompt is required.';
      }

      // Clamp to the provider bounds and default when omitted, so the billed length
      // (reserved in onFinish) always equals the generated length - the deterministic
      // reserve/settle contract the cost model depends on. A non-numeric lengthMs from
      // a lax-schema caller clamps to NaN; reject it here with the tool's own friendly
      // message rather than let estimateMusicCredits throw a generic error from onStart.
      const lengthMs = Math.min(
        MAX_MUSIC_LENGTH_MS,
        Math.max(MIN_MUSIC_LENGTH_MS, Math.round(requestedLengthMs ?? DEFAULT_MUSIC_LENGTH_MS))
      );
      if (!Number.isFinite(lengthMs)) {
        return 'Error: music track length (lengthMs) must be a number of milliseconds.';
      }
      const modelId = DEFAULT_MUSIC_MODEL_ID;

      // Resolve the provider key BEFORE the affordability gate so a caller who is both
      // keyless and low on credits learns the key is missing (the actionable problem)
      // instead of a misleading "insufficient credits". Return (not throw) the generic,
      // non-leaking message so the ReAct loop relays a clear reason and the quest
      // survives; nothing is billed since onFinish - which reserves the charge - is
      // never reached.
      const apiKey = await getEffectiveApiKey(context.userId, { type: ApiKeyType.elevenlabs }, { db: context.db });
      if (!apiKey) {
        context.logger.error('[music_generation] ElevenLabs API key is not configured; refusing to dispatch');
        return 'Error: Music generation is currently unavailable. Please try again later.';
      }

      // Affordability gate only: the host throws insufficient_credits here if the owner
      // can't cover the length-driven charge, BEFORE the paid provider call. The actual
      // reservation is deferred to onFinish (below) so a failed generation is never billed.
      await context.onStart?.('music_generation', { provider: PROVIDER, lengthMs, modelId, prompt });

      await context.statusUpdate({}, 'Composing music...');

      const service = aiMusicService(PROVIDER, apiKey, context.logger);

      let audio: Buffer;
      let contentType: string;
      try {
        ({ audio, contentType } = await service.generate(prompt, { lengthMs, forceInstrumental, modelId }));
      } catch (error) {
        // Return the provider message as the tool result so the model can relay a
        // clear reason instead of the run dying with a generic failure.
        const message = error instanceof Error ? error.message : 'Unknown error';
        context.logger.error(`[music_generation] generation failed: ${message}`);
        return `Error: ${message}`;
      }

      const ext = extensionFromMimeType(contentType) || 'mp3';
      const filename = `${uuidv4()}.${ext}`;

      // Store in the generated-content bucket so the track is CDN-served and renders
      // inline via quest.images. Pass ContentType so S3 serves audio/* and the
      // browser <audio> element can play it.
      const storedPath = await context.imageGenerateStorage.upload(audio, filename, { ContentType: contentType });

      // Keep a browsable copy in the Knowledge Base (best-effort). AUDIO type so it is
      // never chunked/vectorized/attached to a completion.
      await persistGeneratedFileAsFabFile(context, {
        fileName: `generated-music-${filename.slice(0, 8)}.${ext}`,
        mimeType: contentType,
        content: audio,
        type: KnowledgeType.AUDIO,
        tags: [
          { name: 'generated', strength: 1 },
          { name: 'music', strength: 1 },
        ],
      });

      // Reserve + record the charge now that generation succeeded (host settles
      // toolCreditsMap at quest end and appends the path to quest.images). The failure
      // paths above return before here, so an undelivered track is never billed.
      await context.onFinish?.('music_generation', { paths: [storedPath], provider: PROVIDER, lengthMs, modelId });
      await context.statusUpdate({ images: [storedPath] });
      return 'Successfully generated music';
    },
    toolSchema: {
      name: 'music_generation',
      description:
        '🎵 MUSIC GENERATION TOOL: Use this when the user wants to create, generate, compose, or make background music or a music track/song/melody/soundtrack/theme/jingle from a description. Use it for phrases like "generate music", "compose a track", "make me a song", "create background music", "write a melody". This generates an AI music clip from a text description. Pass the user\'s COMPLETE description (mood, genre, instruments, tempo) in a SINGLE call. Do NOT use this for speech/narration (that is text-to-speech) or short sound effects.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              "The music description. Include the user's requested mood, genre, instruments, and tempo as closely as possible.",
          },
          lengthMs: {
            type: 'number',
            description: `Track length in milliseconds. Defaults to ${DEFAULT_MUSIC_LENGTH_MS}. Longer tracks cost more credits.`,
            minimum: MIN_MUSIC_LENGTH_MS,
            maximum: MAX_MUSIC_LENGTH_MS,
          },
          forceInstrumental: {
            type: 'boolean',
            description: 'When true, generate an instrumental track with no vocals.',
          },
        },
        additionalProperties: false,
        required: ['prompt'],
      },
    },
  }),
};
