import {
  type AudioGenerationToolCall,
  type AudioJobOutput,
  DEFAULT_SOUND_MODEL_ID,
  DEFAULT_TTS_PROVIDER,
  extensionFromMimeType,
  type IGenerationJobDocument,
  insufficientCreditsError,
  SOUND_EFFECTS_MAX_INPUT_CHARS,
  type SoundEffectJobRequest,
  type SpeechJobRequest,
  TTS_DEFAULT_MODEL,
  TTS_MAX_INPUT_CHARS,
  type VoiceGenerationVendor,
} from '@bike4mind/common';
import { z } from 'zod';
import type {
  CreateAudioJobInput,
  CreateSoundEffectJobResult,
  CreateSpeechJobInput,
  CreateSpeechJobResult,
} from '../../../../audioJobs/types';
import type { ToolContext, ToolDefinition } from '../../base/types';
import { inlineMinStepMs } from '../../../../audioJobs/shared';
import { settingsModelRefusalOrRethrow } from '../../helpers/toolModelRefusal';
import { buildJobIdempotencyKey, isReplayOfDeadJob } from '../generationJobTool';

/**
 * The speech and sound-effect job functions the tool generates and bills through. Built by the host
 * (server-utils buildAudioToolJobs) because the job deps are server wiring; a host without them gets
 * the unavailable message rather than a second, host-billed path.
 */
export type AudioToolJobs = {
  createSpeechJob(input: CreateSpeechJobInput): Promise<CreateSpeechJobResult>;
  createSoundEffectJob(input: CreateAudioJobInput): Promise<CreateSoundEffectJobResult>;
  /** The job once terminal, or null when it is still running at the timeout (the worker then finishes it). */
  runInline(jobId: string, options: { timeoutMs: number; minStepMs: number }): Promise<IGenerationJobDocument | null>;
  readOutput(output: AudioJobOutput): Promise<Buffer>;
};

/** The user's saved audio settings (the `audioConfig` a chat request carries) plus the host's job functions. */
export type AudioToolConfig = Partial<AudioGenerationToolCall> & { jobs?: AudioToolJobs };

const isAudioToolJobs = (value: unknown): value is AudioToolJobs =>
  typeof value === 'object' &&
  value !== null &&
  'createSpeechJob' in value &&
  typeof value.createSpeechJob === 'function' &&
  'createSoundEffectJob' in value &&
  typeof value.createSoundEffectJob === 'function' &&
  'runInline' in value &&
  typeof value.runInline === 'function' &&
  'readOutput' in value &&
  typeof value.readOutput === 'function';

/** Whether a tool config carries the host's job functions; the tool is not offered without them. */
export const hasAudioToolJobs = (config: unknown): boolean =>
  typeof config === 'object' && config !== null && 'jobs' in config && isAudioToolJobs(config.jobs);

/** Merges the host's job functions into whatever audio settings the request carried (possibly none). */
export const withAudioToolJobs = (audioConfig: unknown, jobs: AudioToolJobs | undefined): unknown =>
  jobs ? { ...(typeof audioConfig === 'object' && audioConfig !== null ? audioConfig : {}), jobs } : audioConfig;

// One provider call takes seconds; this stays under the 60s serving cap with room for the upload after it.
export const AUDIO_JOB_INLINE_TIMEOUT_MS = 55_000;

const SFX_PROVIDER = 'elevenlabs';

/** Generic, non-leaking message when no provider can serve the request. */
const UNAVAILABLE_MESSAGE = 'Error: Audio generation is currently unavailable. Please try again later.';

const BUSY_MESSAGE = 'Error: The audio provider is busy right now. Please try again shortly.';

// Defensive shape check for the model-supplied tool arguments. `kind` stays a loose string
// (the toolFn treats anything that is not 'sound_effect' as speech); this only guards the
// types so a malformed call fails cleanly instead of casting `unknown` and reading garbage.
// `durationSeconds` carries the same 0.5-30s bound the job's request schema enforces.
const audioArgsSchema = z.object({
  kind: z.string().optional(),
  text: z.string().optional(),
  durationSeconds: z.number().min(0.5).max(30).optional(),
});

type AudioKind = 'speech' | 'sound_effect';

const KIND_LABEL: Record<AudioKind, string> = { speech: 'speech', sound_effect: 'sound effect' };

/**
 * In-chat / agent TTS + sound-effects generation. The model picks the `kind` and supplies the
 * text; provider, voice, format and duration default from the user's saved audio settings.
 *
 * Generation and billing ride the speech / sound_effect generation jobs (as the direct
 * /api/ai/tts and /api/ai/sound-effects endpoints do): the job holds credits at create, saves the
 * clip to the user's Files and settles on success, so this tool never uses onStart/onFinish for
 * billing. It steps the job inline, then uploads the bytes to the generated-content bucket and
 * pushes that key onto `quest.images`: the client resolves those keys against that bucket and
 * splits by extension to render an inline audio player.
 */
export const audioGenerationTool: ToolDefinition = {
  name: 'audio_generation',
  implementation: (context, config: unknown) => ({
    toolFn: async val => {
      const audioConfig: AudioToolConfig = typeof config === 'object' && config !== null ? config : {};
      const parsedArgs = audioArgsSchema.safeParse(val);
      if (!parsedArgs.success) {
        return 'Error: audio_generation received invalid arguments.';
      }
      const { kind, text, durationSeconds: toolDurationSeconds } = parsedArgs.data;

      if (!text || !text.trim()) {
        return 'Error: audio_generation requires non-empty text.';
      }

      const { jobs } = audioConfig;
      if (!isAudioToolJobs(jobs)) {
        context.logger.error('[audio_generation] host wired no audio jobs; refusing to generate');
        return UNAVAILABLE_MESSAGE;
      }

      // Anything that is not explicitly a sound effect is speech (the common case),
      // so a caller that omits `kind` still gets a sensible result.
      if (kind === 'sound_effect') {
        if (text.length > SOUND_EFFECTS_MAX_INPUT_CHARS) {
          return `Error: sound-effect description too long (max ${SOUND_EFFECTS_MAX_INPUT_CHARS} characters).`;
        }
        const request: SoundEffectJobRequest = {
          provider: SFX_PROVIDER,
          text,
          durationSeconds: toolDurationSeconds ?? audioConfig.durationSeconds ?? undefined,
          promptInfluence: audioConfig.promptInfluence,
        };
        return generate(context, jobs, 'sound_effect', request, DEFAULT_SOUND_MODEL_ID, SFX_PROVIDER);
      }

      const provider: VoiceGenerationVendor = audioConfig.ttsProvider ?? DEFAULT_TTS_PROVIDER;
      if (text.length > TTS_MAX_INPUT_CHARS[provider]) {
        return `Error: text too long for ${provider} speech (max ${TTS_MAX_INPUT_CHARS[provider]} characters).`;
      }
      const request: SpeechJobRequest = {
        text,
        provider,
        voice: audioConfig.voice || undefined,
        // Chat's output contract is inline playback, and raw PCM has no container <audio> can
        // decode (see the inline-audio regex in generatedMedia.ts), so a pcm setting becomes mp3.
        format: audioConfig.format === 'pcm' ? 'mp3' : audioConfig.format,
        ...(provider === 'elevenlabs' && audioConfig.languageCode && { languageCode: audioConfig.languageCode }),
      };
      return generate(context, jobs, 'speech', request, TTS_DEFAULT_MODEL[provider], provider);
    },
    toolSchema: {
      name: 'audio_generation',
      description:
        '🔊 AUDIO GENERATION TOOL: Generate spoken audio (text-to-speech) or a short sound effect from text. Use kind="speech" when the user wants something read aloud / narrated / voiced ("say this", "read this out loud", "narrate", "voice this"). Use kind="sound_effect" for a short non-speech sound described in words ("a dog barking", "rain on a tin roof", "a whoosh"); sound effects require an ElevenLabs API key (speech also works with OpenAI). Do NOT use this for music or songs (that is music_generation). Voice, provider and format come from the user\'s saved audio settings; just pass the text.',
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

async function generate(
  context: ToolContext,
  jobs: AudioToolJobs,
  kind: AudioKind,
  request: SpeechJobRequest | SoundEffectJobRequest,
  modelId: string,
  provider: string
): Promise<string> {
  const label = KIND_LABEL[kind];
  const input: CreateAudioJobInput = {
    // The turn's already-resolved organization is the one the chat bills, so the job bills the same owner.
    user: {
      id: context.userId,
      organizationId: context.organizationId ?? null,
      adminRoleWithheld: !context.user.isAdmin,
    },
    request,
    source: 'agent',
    apiKeyId: context.apiKeyId,
    saveToFiles: true,
    sessionId: context.sessionId,
    questId: context.questId,
    idempotencyKey: buildJobIdempotencyKey(context.userId, context.questId, { kind, ...request }),
  };
  const create = (saveToFiles: boolean) =>
    kind === 'speech'
      ? jobs.createSpeechJob({ ...input, saveToFiles, preferredVoice: context.user.preferredVoice })
      : jobs.createSoundEffectJob({ ...input, saveToFiles });

  // Status only (live chat status line and the voice preamble): billing is the job's.
  await context.onStart?.('audio_generation', { kind });

  let created: CreateSpeechJobResult | CreateSoundEffectJobResult;
  try {
    created = await create(true);
    // As the audio routes: a full Files quota still gets the clip inline, just without the saved copy.
    if (!created.ok && created.code === 'storage_quota_exceeded') created = await create(false);
  } catch (error) {
    // createXJob asserts model admission itself; its REST callers need the throw, the model needs a result.
    return settingsModelRefusalOrRethrow(context, error, modelId, 'audio_generation');
  }
  if (!created.ok) {
    switch (created.code) {
      // Thrown, not returned: an out-of-credits tool error ends the turn with the add-credits notice.
      case 'insufficient_credits':
        throw insufficientCreditsError(created.message);
      case 'daily_limit_reached':
        return `Error: ${created.message} Do not call audio_generation again today.`;
      case 'model_unavailable':
        context.logger.error('[audio_generation] no provider can serve the request', { kind });
        // Speech works with OpenAI or ElevenLabs, sound effects need ElevenLabs: give a speech-capable
        // caller something actionable instead of "nothing works, try later".
        return kind === 'sound_effect'
          ? 'Error: sound effects require an ElevenLabs API key; speech (kind="speech") is available.'
          : UNAVAILABLE_MESSAGE;
      default:
        return `Error: ${label} request refused: ${created.message}`;
    }
  }
  if (isReplayOfDeadJob(created.created, created.job.state)) {
    const reason = created.job.error?.code ?? created.job.state;
    return (
      `Error: ${label} generation failed (${reason}): an identical request already ended without audio. ` +
      'Change the text to try again.'
    );
  }

  await context.statusUpdate({}, kind === 'speech' ? 'Generating speech...' : 'Generating sound effect...');

  let job: IGenerationJobDocument | null;
  try {
    job = await jobs.runInline(created.job.id, {
      timeoutMs: AUDIO_JOB_INLINE_TIMEOUT_MS,
      minStepMs: inlineMinStepMs(kind),
    });
  } catch (error) {
    // The queued message still runs the job, so its outcome is unknown rather than failed.
    context.logger.error('[audio_generation] inline run failed', {
      jobId: created.job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return stillGenerating(label, created.job.payload.saveToFiles);
  }
  if (!job) {
    context.logger.warn('[audio_generation] job still running at the inline timeout', { jobId: created.job.id });
    return stillGenerating(label, created.job.payload.saveToFiles);
  }
  const output = jobOutput(job);
  if (job.state !== 'succeeded' || !output) {
    context.logger.error('[audio_generation] job ended without a clip', {
      jobId: job.id,
      state: job.state,
      errorCode: job.error?.code,
    });
    if (job.state === 'failed' && job.error?.providerStatus === 429) return BUSY_MESSAGE;
    // Generic message, not the job's provider error: provider strings can echo key hints or upstream URLs.
    const resolvedProvider = job.kind === 'speech' ? (job.payload.producedBy?.provider ?? provider) : provider;
    return kind === 'speech'
      ? `Error: TTS request rejected by the ${resolvedProvider} provider.`
      : `Error: sound-effect request rejected by the ${resolvedProvider} provider.`;
  }

  let storedPath: string;
  try {
    storedPath = await uploadForInlinePlayback(context, job.id, await jobs.readOutput(output), output.contentType);
  } catch (error) {
    context.logger.error('[audio_generation] could not stage the clip for inline playback', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return output.location === 'files'
      ? `The ${label} was generated and saved to the user's Files, but could not be shown inline in the chat.`
      : `The ${label} was generated, but could not be shown inline in the chat.`;
  }
  await context.statusUpdate({ images: [storedPath] });
  return kind === 'speech' ? 'Successfully generated speech' : 'Successfully generated sound effect';
}

const stillGenerating = (label: string, savesToFiles: boolean) =>
  `The ${label} is still generating.` +
  (savesToFiles ? " It will be saved to the user's Files when it finishes." : '') +
  ' Do not call audio_generation again for it.';

const jobOutput = (job: IGenerationJobDocument): AudioJobOutput | undefined =>
  job.kind === 'speech' || job.kind === 'sound_effect' ? job.payload.output : undefined;

/**
 * Uploads the clip to the generated-content bucket, which is what the inline player streams from. Named by the job,
 * so a replayed success restages the same key instead of rendering a second player.
 */
async function uploadForInlinePlayback(
  context: ToolContext,
  jobId: string,
  audio: Buffer,
  contentType: string
): Promise<string> {
  const filename = `${jobId}.${extensionFromMimeType(contentType) || 'mp3'}`;
  // ContentType so S3 serves audio/* and the browser <audio> element can play it.
  return context.imageGenerateStorage.upload(audio, filename, { ContentType: contentType });
}
