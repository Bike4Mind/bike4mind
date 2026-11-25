import {
  DEFAULT_SOUND_MODEL_ID,
  DEFAULT_TTS_PROVIDER,
  insufficientCreditsError,
  type IGenerationJobDocument,
  type SoundEffectJobRequest,
  type SpeechJobRequest,
  TTS_DEFAULT_MODEL,
} from '@bike4mind/common';
import { inlineMinStepMs, type AudioJobKind } from '../../../../audioJobs/shared';
import type { CreateAudioJobInput } from '../../../../audioJobs/types';
import type { ToolContext } from '../../base/types';
import { settingsModelRefusalOrRethrow } from '../../helpers/toolModelRefusal';
import { AUDIO_JOB_INLINE_TIMEOUT_MS } from '../audioGeneration';
import type { ProductionAudioAdapter, ProductionAudioResult, ProductionAudioSettings } from './config';
import { attemptKey, createWithRetry, DEAD_REPLAY_MESSAGE } from './jobs';

type Context = Omit<ToolContext, 'config'>;
type CreatedAudioJob = Awaited<
  ReturnType<
    ProductionAudioSettings['jobs']['createSpeechJob'] | ProductionAudioSettings['jobs']['createSoundEffectJob']
  >
>;

const SFX_PROVIDER = 'elevenlabs';
const SPEECH_WORDS_PER_MINUTE = 150;

/**
 * The measured length of an mp3 counts every frame, including the encoder's start delay and end padding that a
 * player drops, so it can read up to two frames (about 52 ms) longer than the clip the editor plays. A placed clip
 * keeps this much clear of the end so it never plays past its source.
 */
export const MP3_TAIL_MARGIN_MS = 60;

const estimateSpeechSeconds = (text: string): number =>
  (text.trim().split(/\s+/).length / SPEECH_WORDS_PER_MINUTE) * 60;

function toResult(
  job: IGenerationJobDocument | null,
  fallbackSeconds: number,
  maxSeconds = Infinity
): ProductionAudioResult {
  if (!job) {
    return { ok: false, code: 'pending', message: 'still generating; call production_add_audio again to place it' };
  }
  const output = job.kind === 'speech' || job.kind === 'sound_effect' ? job.payload.output : undefined;
  if (job.state !== 'succeeded' || !output) {
    return { ok: false, code: job.error?.code ?? job.state, message: `the clip ${job.state}` };
  }
  if (!output.fileId) {
    return { ok: false, code: 'not_saved', message: 'the clip was generated but could not be saved to Files' };
  }
  const seconds = Math.min(output.durationSeconds || fallbackSeconds, maxSeconds);
  return { ok: true, fileId: output.fileId, durationMs: Math.max(1, Math.round(seconds * 1000) - MP3_TAIL_MARGIN_MS) };
}

/**
 * Speech and sound effects for the director tools, as speech and sound_effect generation jobs: the run's capped
 * job functions hold and settle credits per clip and save it to Files. Keyed like the other director jobs, so a
 * re-call attaches to a clip still running and a failed one is tried again under the next key.
 */
export function createProductionAudio(context: Context, audio: ProductionAudioSettings): ProductionAudioAdapter {
  const { jobs } = audio;

  const run = async (
    kind: AudioJobKind,
    request: SpeechJobRequest | SoundEffectJobRequest,
    modelId: string,
    fallbackSeconds: number,
    // A sound effect is made at the length asked for; its measured length can only run long.
    maxSeconds?: number
  ): Promise<ProductionAudioResult> => {
    const input = (attempt: number): CreateAudioJobInput => ({
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
      idempotencyKey: attemptKey(context, { kind, ...request }, attempt),
    });
    let created: CreatedAudioJob | undefined;
    try {
      created = await createWithRetry<CreatedAudioJob>(attempt =>
        kind === 'speech'
          ? jobs.createSpeechJob({ ...input(attempt), preferredVoice: context.user.preferredVoice })
          : jobs.createSoundEffectJob(input(attempt))
      );
    } catch (error) {
      return {
        ok: false,
        code: 'model_refused',
        message: settingsModelRefusalOrRethrow(context, error, modelId, 'production_add_audio'),
      };
    }
    if (!created) return { ok: false, code: 'failed', message: DEAD_REPLAY_MESSAGE };
    if (!created.ok) {
      // As audio_generation: running out of credits ends the turn with the add-credits notice.
      if (created.code === 'insufficient_credits') throw insufficientCreditsError(created.message);
      return { ok: false, code: created.code, message: created.message };
    }
    // Audio jobs run inline and have no Quest job card (QUEST_GENERATION_JOB_KINDS), as in audio_generation.
    await context.statusUpdate({}, kind === 'speech' ? 'Generating voiceover...' : 'Generating sound effect...');
    const job = await jobs.runInline(created.job.id, {
      timeoutMs: AUDIO_JOB_INLINE_TIMEOUT_MS,
      minStepMs: inlineMinStepMs(kind),
    });
    return toResult(job, fallbackSeconds, maxSeconds);
  };

  return {
    speech({ text }) {
      const provider = audio.ttsProvider ?? DEFAULT_TTS_PROVIDER;
      const request: SpeechJobRequest = {
        text,
        provider,
        voice: audio.voice || undefined,
        // A timeline clip needs a container the preview and render can decode, as inline playback does.
        format: 'mp3',
        ...(provider === 'elevenlabs' && audio.languageCode && { languageCode: audio.languageCode }),
      };
      return run('speech', request, TTS_DEFAULT_MODEL[provider], estimateSpeechSeconds(text));
    },
    soundEffect({ prompt, durationSeconds }) {
      const request: SoundEffectJobRequest = {
        provider: SFX_PROVIDER,
        text: prompt,
        durationSeconds,
        promptInfluence: audio.promptInfluence,
      };
      return run('sound_effect', request, DEFAULT_SOUND_MODEL_ID, durationSeconds, durationSeconds);
    },
  };
}
