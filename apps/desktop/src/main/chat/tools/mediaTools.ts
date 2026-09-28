import {
  DEFAULT_MUSIC_LENGTH_MS,
  DEFAULT_MUSIC_MODEL_ID,
  ImageModels,
  TTS_MAX_INPUT_CHARS,
  type VoiceGenerationVendor,
} from '@bike4mind/common';
import {
  generateMusic,
  generateSoundEffect,
  synthesizeSpeech,
  type AudioDeps,
  type AudioOutcome,
} from '../media/audioGeneration';
import { generateImage } from '../media/imageGeneration';
import { MediaToolError } from '../media/MediaApiClient';
import {
  optionalNumber,
  requireString,
  type ApprovalPrompt,
  type MediaContext,
  type ToolContext,
  type ToolDefinition,
} from './types';

/**
 * Why all four of these are gated behind the approval the shell tools use.
 *
 * The local tools are gated for SAFETY - a command runs code on the machine. These are gated
 * for COST: every one of them spends the user's credits at a provider, and unlike a bad file
 * read a bad generation cannot be undone by reading the right file next. The same dialog reads
 * correctly for both because what it actually asks is "do this thing on my behalf", and the
 * alternative - letting a model spend money unattended because the request happened to be
 * harmless to the filesystem - is the worse default.
 *
 * `key` carries the full request, so "always in this chat" covers a retry of the identical
 * generation and nothing else. A different prompt is a different spend and asks again.
 */

/**
 * Preferred image model, when the deployment offers it. The cheapest of the current OpenAI
 * image family on purpose: this runs on someone's credits at a model's discretion, so the
 * default is the low-cost one and a caller who wants better names it explicitly.
 */
const PREFERRED_IMAGE_MODEL: string = ImageModels.GPT_IMAGE_1_MINI;

const DEFAULT_TTS_PROVIDER: VoiceGenerationVendor = 'openai';

function requireMedia(context: ToolContext): MediaContext {
  if (!context.media) {
    throw new Error('Generation is unavailable: this app is not signed in to a Bike4Mind server.');
  }
  return context.media;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Bytes as the approval prompt and the model-facing result both want to read them. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line of the prompt, cut so a wall of text cannot push the buttons off screen. */
function excerpt(text: string, limit = 400): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 3)}...`;
}

/**
 * Run a generation, lifting a credit or provider outcome onto the call before it propagates.
 *
 * The notice has to be reported even on the failure path: "you are out of credits" is the one
 * failure the user can act on, and it must not arrive as red monospace text inside a collapsed
 * tool call.
 */
async function reporting<T>(context: ToolContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MediaToolError && error.notice) context.report?.notice(error.notice);
    throw error;
  }
}

/**
 * Which image model to send. Resolved against the server's catalog rather than guessed: the
 * list is assembled from the account's effective provider keys, so a hardcoded id would 4xx on
 * a stack that holds no key for it. A named model the server does not offer is refused here,
 * with the offered ids in the message, rather than spent on a rejected request.
 */
async function resolveImageModel(media: MediaContext, requested: string | undefined): Promise<string> {
  const offered = await media.listImageModels();

  if (requested) {
    if (offered.length > 0 && !offered.includes(requested)) {
      throw new Error(`This server does not offer the image model "${requested}". It offers: ${offered.join(', ')}.`);
    }
    return requested;
  }

  if (offered.length === 0) {
    throw new Error('This server offers no image-generation models, so there is nothing to generate with.');
  }
  return offered.includes(PREFERRED_IMAGE_MODEL) ? PREFERRED_IMAGE_MODEL : offered[0];
}

export const generateImageTool: ToolDefinition = {
  schema: {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt on the Bike4Mind server and show it to the user. ' +
      'Costs the user credits and takes tens of seconds. The image is displayed to the USER; ' +
      'you do not receive it and cannot see what it depicts.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to draw. Be specific; the server may refine it.' },
        model: {
          type: 'string',
          description: 'Image model id. Omit to use this deployment default; a model it does not offer is refused.',
        },
        size: { type: 'string', description: 'Requested size, e.g. "1024x1024". Omit for the model default.' },
      },
      required: ['prompt'],
    },
  },

  async approval(input, context) {
    const media = requireMedia(context);
    const prompt = requireString(input, 'prompt');
    const model = await resolveImageModel(media, optionalString(input, 'model'));
    const size = optionalString(input, 'size');

    return {
      detail:
        `Generate an image with ${model}${size ? ` at ${size}` : ''}.\n` +
        'This spends credits on your Bike4Mind account.\n\n' +
        excerpt(prompt),
      key: `generate_image:${model}:${size ?? ''}:${prompt}`,
    } satisfies ApprovalPrompt;
  },

  async run(input, context) {
    const media = requireMedia(context);
    const prompt = requireString(input, 'prompt');
    const model = await resolveImageModel(media, optionalString(input, 'model'));

    return reporting(context, async () => {
      const outcome = await generateImage(
        {
          prompt,
          model,
          ...(optionalString(input, 'size') ? { size: optionalString(input, 'size') } : {}),
          ...(media.getRemoteSessionId() ? { remoteSessionId: media.getRemoteSessionId() } : {}),
          notebookName: media.notebookName,
        },
        {
          client: media.client,
          store: media.store,
          sessionId: context.sessionId ?? '',
          cdnUrl: media.cdnUrl,
          signal: context.signal,
          progress: text => context.report?.progress(text),
        }
      );

      if (outcome.remoteSessionId && outcome.remoteSessionId !== media.getRemoteSessionId()) {
        await media.setRemoteSessionId(outcome.remoteSessionId);
      }
      for (const item of outcome.media) context.report?.media(item);

      const sizes = outcome.media.map(item => formatBytes(item.byteLength)).join(', ');
      return (
        `Generated ${outcome.media.length} image(s) with ${model} (${sizes}) and displayed them to the user. ` +
        'You cannot see the result, so do not describe what it depicts - ask the user if you need to know.'
      );
    });
  },
};

/** Shared by the three Audio-tag tools: report the media, then say what happened. */
function describeAudio(context: ToolContext, outcome: AudioOutcome, what: string): string {
  context.report?.media(outcome.media);
  if (outcome.notice) context.report?.notice(outcome.notice);

  return [
    `Generated ${what} (${outcome.media.mimeType}, ${formatBytes(outcome.media.byteLength)}) and gave the user a player for it.`,
    outcome.notice ? outcome.notice.text : '',
    outcome.fabFileId ? `Saved to the file browser as ${outcome.fabFileId}.` : '',
    'You cannot hear it; do not claim to have checked how it sounds.',
  ]
    .filter(Boolean)
    .join(' ');
}

function audioDeps(context: ToolContext, media: MediaContext): AudioDeps {
  return { client: media.client, store: media.store, sessionId: context.sessionId ?? '' };
}

export const generateSpeechTool: ToolDefinition = {
  schema: {
    name: 'generate_speech',
    description:
      'Read text aloud using the Bike4Mind server text-to-speech, and give the user a player for it. ' +
      'Costs the user credits. If the chosen provider has no key on this server, another one is ' +
      'substituted and the user is told.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to speak.' },
        provider: { type: 'string', enum: ['openai', 'elevenlabs'], description: 'Defaults to openai.' },
        voice: { type: 'string', description: 'Provider voice id. Omit for the account or provider default.' },
        format: {
          type: 'string',
          enum: ['mp3', 'wav', 'opus', 'aac', 'flac'],
          description: 'Output container. Defaults to mp3.',
        },
      },
      required: ['text'],
    },
  },

  approval(input) {
    const text = requireString(input, 'text');
    const provider = (optionalString(input, 'provider') ?? DEFAULT_TTS_PROVIDER) as VoiceGenerationVendor;
    const voice = optionalString(input, 'voice');

    return {
      detail:
        `Speak ${text.length} characters with ${provider}${voice ? ` (voice ${voice})` : ''}.\n` +
        'This spends credits on your Bike4Mind account.\n\n' +
        excerpt(text),
      key: `generate_speech:${provider}:${voice ?? ''}:${text}`,
    } satisfies ApprovalPrompt;
  },

  async run(input, context) {
    const media = requireMedia(context);
    const text = requireString(input, 'text');
    const provider = (optionalString(input, 'provider') ?? DEFAULT_TTS_PROVIDER) as VoiceGenerationVendor;

    // Checked here as well as on the server so an over-long request is refused before the user
    // is asked to approve a spend that would 422 anyway.
    const limit = TTS_MAX_INPUT_CHARS[provider];
    if (limit && text.length > limit) {
      throw new Error(`That is ${text.length} characters; ${provider} accepts at most ${limit}. Shorten it.`);
    }

    return reporting(context, async () => {
      const outcome = await synthesizeSpeech(
        {
          text,
          provider,
          ...(optionalString(input, 'voice') ? { voice: optionalString(input, 'voice') } : {}),
          ...(optionalString(input, 'format')
            ? {
                format: optionalString(input, 'format') as NonNullable<
                  Parameters<typeof synthesizeSpeech>[0]['format']
                >,
              }
            : {}),
        },
        audioDeps(context, media)
      );
      return describeAudio(context, outcome, 'speech');
    });
  },
};

export const generateSoundEffectTool: ToolDefinition = {
  schema: {
    name: 'generate_sound_effect',
    description:
      'Generate a short sound effect from a text description and give the user a player for it. ' +
      'Costs the user credits. Requires an ElevenLabs key on the server.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What the sound should be, e.g. "heavy wooden door creaking open".' },
        durationSeconds: { type: 'number', description: 'Clip length, 0.5-30. Omit to let the provider choose.' },
        promptInfluence: { type: 'number', description: 'Prompt fidelity, 0 (loose) to 1 (strict).' },
      },
      required: ['text'],
    },
  },

  approval(input) {
    const text = requireString(input, 'text');
    const seconds = optionalNumber(input, 'durationSeconds');

    return {
      detail:
        `Generate a sound effect${seconds ? ` of about ${seconds}s` : ''} with elevenlabs.\n` +
        'This spends credits on your Bike4Mind account.\n\n' +
        excerpt(text),
      key: `generate_sound_effect:${seconds ?? ''}:${text}`,
    } satisfies ApprovalPrompt;
  },

  async run(input, context) {
    const media = requireMedia(context);

    return reporting(context, async () => {
      const outcome = await generateSoundEffect(
        {
          provider: 'elevenlabs',
          text: requireString(input, 'text'),
          ...(optionalNumber(input, 'durationSeconds') !== undefined
            ? { durationSeconds: optionalNumber(input, 'durationSeconds') }
            : {}),
          ...(optionalNumber(input, 'promptInfluence') !== undefined
            ? { promptInfluence: optionalNumber(input, 'promptInfluence') }
            : {}),
        },
        audioDeps(context, media)
      );
      return describeAudio(context, outcome, 'a sound effect');
    });
  },
};

export const generateMusicTool: ToolDefinition = {
  schema: {
    name: 'generate_music',
    description:
      'Generate a background-music track from a text prompt and give the user a player for it. ' +
      'Costs the user credits, billed by length. Requires an ElevenLabs key on the server.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The track to generate, e.g. "calm lo-fi study beat".' },
        lengthMs: { type: 'number', description: 'Track length in milliseconds, 3000-120000. Defaults to 10000.' },
        forceInstrumental: { type: 'boolean', description: 'Suppress vocals.' },
      },
      required: ['prompt'],
    },
  },

  approval(input) {
    const prompt = requireString(input, 'prompt');
    const lengthMs = optionalNumber(input, 'lengthMs') ?? DEFAULT_MUSIC_LENGTH_MS;

    return {
      detail:
        `Generate ${Math.round(lengthMs / 1000)}s of music with elevenlabs.\n` +
        'This spends credits on your Bike4Mind account, billed by track length.\n\n' +
        excerpt(prompt),
      key: `generate_music:${lengthMs}:${prompt}`,
    } satisfies ApprovalPrompt;
  },

  async run(input, context) {
    const media = requireMedia(context);
    const lengthMs = optionalNumber(input, 'lengthMs') ?? DEFAULT_MUSIC_LENGTH_MS;

    return reporting(context, async () => {
      const outcome = await generateMusic(
        {
          provider: 'elevenlabs',
          prompt: requireString(input, 'prompt'),
          lengthMs,
          modelId: DEFAULT_MUSIC_MODEL_ID,
          ...(typeof input.forceInstrumental === 'boolean' ? { forceInstrumental: input.forceInstrumental } : {}),
        },
        audioDeps(context, media)
      );
      return describeAudio(context, outcome, `${Math.round(lengthMs / 1000)}s of music`);
    });
  },
};
