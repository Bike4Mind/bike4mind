/**
 * The `audio_generation` job functions for agent-mode runs (the parent and its in-process subagents).
 *
 * Same job functions as chat (server-utils buildAudioToolJobs), plus the `agentSpeechClipsPerRun` and
 * `agentSoundEffectsPerRun` per-run caps (agentExecutor.generationJobCap.ts). Speech and sound-effect jobs hold
 * and settle their own credits, so nothing here touches agentExecutor.billing.ts.
 */
import type { AudioToolJobs } from '@bike4mind/services/llm/tools';
import type { Logger } from '@bike4mind/observability';
import { buildAudioToolJobs } from '@bike4mind/server-utils/generationJobs/audioJobWiring';
import {
  limitJobsPerRun,
  questGenerationSlots,
  resolveAgentRunLimit,
  type AgentGenerationSlots,
  type AgentRunLimitCaller,
} from './agentExecutor.generationJobCap';

export const AGENT_SPEECH_CLIPS_SETTING_KEY = 'agentSpeechClipsPerRun' as const;
export const AGENT_SOUND_EFFECTS_SETTING_KEY = 'agentSoundEffectsPerRun' as const;

export type AgentAudioToolJobsDeps = {
  buildBaseJobs(): AudioToolJobs;
  resolveSpeechLimit(caller: AgentRunLimitCaller): Promise<number>;
  resolveSoundEffectLimit(caller: AgentRunLimitCaller): Promise<number>;
  speechSlots: AgentGenerationSlots;
  soundEffectSlots: AgentGenerationSlots;
  logger: Logger;
};

export type BuildAgentAudioToolJobsInput = {
  userId: string;
  organizationId?: string;
  /** Set when an API key started the run; such runs keep the uncapped job functions. */
  apiKeyId?: string;
  /** The run's real Quest id (resolveExecutionQuestId), which carries the per-run counters. */
  questId?: string;
  /** Whether the run's toolbelt names audio_generation; skips the settings reads otherwise. */
  toolEnabled: boolean;
};

type LimitAudioClipsOptions = {
  questId: string;
  speechLimit: number;
  soundEffectLimit: number;
  speechSlots: AgentGenerationSlots;
  soundEffectSlots: AgentGenerationSlots;
  logger: Logger;
};

const limitMessage = (limit: number, singular: string, plural: string): string =>
  limit <= 0
    ? `Agent runs cannot generate ${plural} here. Do not retry; tell the user the limit was reached.`
    : `This run has already started its limit of ${limit} ${limit === 1 ? singular : plural}. Do not retry; tell the user the limit was reached.`;

/**
 * Wraps createSpeechJob and createSoundEffectJob so a call past either cap returns a tool error instead of
 * starting a clip (see limitJobsPerRun). A limit of 0 refuses every call of that kind; the tool stays offered.
 */
export function limitAudioClipsPerRun(
  jobs: AudioToolJobs,
  { questId, speechLimit, soundEffectLimit, speechSlots, soundEffectSlots, logger }: LimitAudioClipsOptions
): AudioToolJobs {
  return {
    ...jobs,
    createSpeechJob: limitJobsPerRun(jobs.createSpeechJob, {
      questId,
      limit: speechLimit,
      slots: speechSlots,
      logger,
      logTag: '[AgentAudio]',
      releaseNoun: 'speech clip',
      refusal: {
        ok: false,
        status: 403,
        code: 'speech_limit_reached',
        message: limitMessage(speechLimit, 'speech clip', 'speech clips'),
      },
    }),
    createSoundEffectJob: limitJobsPerRun(jobs.createSoundEffectJob, {
      questId,
      limit: soundEffectLimit,
      slots: soundEffectSlots,
      logger,
      logTag: '[AgentAudio]',
      releaseNoun: 'sound effect',
      refusal: {
        ok: false,
        status: 403,
        code: 'sound_effect_limit_reached',
        message: limitMessage(soundEffectLimit, 'sound effect', 'sound effects'),
      },
    }),
  };
}

/**
 * The capped job functions when the run has a Quest to count on and no API key; otherwise the uncapped chat ones,
 * as before the caps existed. A failed limit read (resolveAgentRunLimit degrades rather than throws, so this is
 * unexpected) fails closed: both kinds are refused for this invocation.
 */
export async function buildAgentAudioToolJobs(
  { userId, organizationId, apiKeyId, questId, toolEnabled }: BuildAgentAudioToolJobsInput,
  deps: AgentAudioToolJobsDeps
): Promise<AudioToolJobs> {
  const base = deps.buildBaseJobs();
  if (!toolEnabled || apiKeyId || !questId) return base;
  const caller = { userId, organizationId };
  const [speechLimit, soundEffectLimit] = await Promise.all([
    deps.resolveSpeechLimit(caller),
    deps.resolveSoundEffectLimit(caller),
  ]).catch((error: unknown) => {
    deps.logger.warn('[AgentAudio] could not read the per-run audio limits; refusing audio this invocation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [0, 0];
  });
  return limitAudioClipsPerRun(base, {
    questId,
    speechLimit,
    soundEffectLimit,
    speechSlots: deps.speechSlots,
    soundEffectSlots: deps.soundEffectSlots,
    logger: deps.logger,
  });
}

export function getAgentAudioToolJobsDeps(logger: Logger): AgentAudioToolJobsDeps {
  return {
    buildBaseJobs: buildAudioToolJobs,
    resolveSpeechLimit: resolveAgentRunLimit(AGENT_SPEECH_CLIPS_SETTING_KEY, logger),
    resolveSoundEffectLimit: resolveAgentRunLimit(AGENT_SOUND_EFFECTS_SETTING_KEY, logger),
    speechSlots: questGenerationSlots('speech'),
    soundEffectSlots: questGenerationSlots('sound_effect'),
    logger,
  };
}
