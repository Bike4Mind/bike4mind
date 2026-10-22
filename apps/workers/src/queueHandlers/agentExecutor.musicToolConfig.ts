/**
 * The `music_generation` tool config for agent-mode runs (the parent and its in-process subagents).
 *
 * Same base config as chat (questProcessor.getMusicToolConfigResolver) and the same exclusions as
 * agentExecutor.videoToolConfig.ts, plus the `agentMusicTracksPerRun` per-run cap
 * (agentExecutor.generationJobCap.ts). Music jobs hold and settle their own credits, so nothing here
 * touches agentExecutor.billing.ts.
 */
import type { MusicToolConfig } from '@bike4mind/services/llm/tools';
import type { Logger } from '@bike4mind/observability';
import { getCreateMusicJobDeps, getMusicJobDeps } from '@server/generationJobs/wiring';
import { buildMusicToolConfig } from '@server/musicGenerations/buildMusicToolConfig';
import {
  limitJobsPerRun,
  questGenerationSlots,
  resolveAgentRunLimit,
  type AgentGenerationSlots,
  type AgentRunLimitCaller,
} from './agentExecutor.generationJobCap';

export const AGENT_MUSIC_TRACKS_SETTING_KEY = 'agentMusicTracksPerRun' as const;

export type AgentMusicToolConfigDeps = {
  buildBaseConfig(userId: string): Promise<MusicToolConfig | null>;
  resolveTrackLimit(caller: AgentRunLimitCaller): Promise<number>;
  slots: AgentGenerationSlots;
  logger: Logger;
};

export type BuildAgentMusicToolConfigInput = {
  userId: string;
  organizationId?: string;
  /** Set when an API key started the run; such runs never get the tool. */
  apiKeyId?: string;
  /** The run's real Quest id (resolveExecutionQuestId); the song card attaches to it. */
  questId?: string;
  /** Whether the run's toolbelt names music_generation; skips the settings and key reads otherwise. */
  toolEnabled: boolean;
};

type LimitMusicTracksOptions = {
  questId: string;
  limit: number;
  slots: AgentGenerationSlots;
  logger: Logger;
};

/**
 * Wraps `createJob` so a call past the cap returns a tool error instead of starting a song (see limitJobsPerRun),
 * and gives back the slot of a song the tool discarded for a rephrase, so the rephrased song still fits the cap.
 */
export function limitMusicTracksPerRun(
  config: MusicToolConfig,
  { questId, limit, slots, logger }: LimitMusicTracksOptions
): MusicToolConfig {
  return {
    ...config,
    releaseDiscardedJob: async jobId => {
      await config.releaseDiscardedJob?.(jobId);
      await slots.release(questId).catch(error =>
        logger.warn('[AgentMusic] failed to release a discarded song slot; the run keeps one fewer', {
          questId,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    },
    createJob: limitJobsPerRun(config.createJob, {
      questId,
      limit,
      slots,
      logger,
      logTag: '[AgentMusic]',
      releaseNoun: 'song',
      refusal: {
        ok: false,
        status: 403,
        code: 'track_limit_reached',
        message: `This run has already started its limit of ${limit} song${limit === 1 ? '' : 's'}. Do not retry; tell the user the limit was reached.`,
      },
    }),
  };
}

/**
 * Null means the tool is not offered: not in the toolbelt, an API-key run (same exclusion as chat), no
 * Quest to count on or attach the song card to, a cap of 0, no usable music model, or a failed config
 * build (fail closed). A failed settings read does not land here: resolveAgentRunLimit degrades it.
 */
export async function buildAgentMusicToolConfig(
  { userId, organizationId, apiKeyId, questId, toolEnabled }: BuildAgentMusicToolConfigInput,
  deps: AgentMusicToolConfigDeps
): Promise<MusicToolConfig | null> {
  if (!toolEnabled || apiKeyId || !questId) return null;
  try {
    const limit = await deps.resolveTrackLimit({ userId, organizationId });
    if (limit <= 0) return null;
    const base = await deps.buildBaseConfig(userId);
    return base && limitMusicTracksPerRun(base, { questId, limit, slots: deps.slots, logger: deps.logger });
  } catch (error) {
    deps.logger.warn('[AgentMusic] could not build the music tool config; tool not offered this invocation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function getAgentMusicToolConfigDeps(logger: Logger): AgentMusicToolConfigDeps {
  return {
    buildBaseConfig: userId =>
      buildMusicToolConfig(userId, { availability: getMusicJobDeps(), createDeps: getCreateMusicJobDeps() }),
    resolveTrackLimit: resolveAgentRunLimit(AGENT_MUSIC_TRACKS_SETTING_KEY, logger),
    slots: questGenerationSlots('music'),
    logger,
  };
}
