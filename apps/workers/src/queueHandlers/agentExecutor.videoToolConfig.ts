/**
 * The `video_generation` tool config for agent-mode runs (the parent and its in-process subagents).
 *
 * Chat builds the same base config (questProcessor.getVideoToolConfigResolver); agent mode adds the
 * `agentVideoClipsPerRun` per-run cap on top (agentExecutor.generationJobCap.ts). Lambda-dispatched
 * subagents get no native tools at all today (processSubagentDispatch passes no `enabledTools`), so
 * they get no video either; giving them native tools must reuse this config, keyed on the shared `linkedQuestId`.
 * Video jobs hold and settle their own credits, so nothing here touches agentExecutor.billing.ts.
 */
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import type { Logger } from '@bike4mind/observability';
import { getCreateVideoJobDeps, getVideoJobDeps } from '@server/generationJobs/wiring';
import { buildVideoToolConfig } from '@server/videoGenerations/buildVideoToolConfig';
import {
  limitJobsPerRun,
  questGenerationSlots,
  resolveAgentRunLimit,
  type AgentGenerationSlots,
  type AgentRunLimitCaller,
} from './agentExecutor.generationJobCap';

export const AGENT_VIDEO_CLIPS_SETTING_KEY = 'agentVideoClipsPerRun' as const;

export type AgentVideoToolConfigDeps = {
  buildBaseConfig(userId: string): Promise<VideoToolConfig | null>;
  resolveClipLimit(caller: AgentRunLimitCaller): Promise<number>;
  slots: AgentGenerationSlots;
  logger: Logger;
};

export type BuildAgentVideoToolConfigInput = {
  userId: string;
  organizationId?: string;
  /** Set when an API key started the run; such runs never get the tool. */
  apiKeyId?: string;
  /** The run's real Quest id (resolveExecutionQuestId). */
  questId?: string;
  /** Whether the run's toolbelt names video_generation; skips the settings and key reads otherwise. */
  toolEnabled: boolean;
};

type LimitVideoClipsOptions = {
  questId: string;
  limit: number;
  slots: AgentGenerationSlots;
  logger: Logger;
};

/** Wraps `createJob` so a call past the cap returns a tool error instead of starting a clip (see limitJobsPerRun). */
export function limitVideoClipsPerRun(
  config: VideoToolConfig,
  { questId, limit, slots, logger }: LimitVideoClipsOptions
): VideoToolConfig {
  return {
    ...config,
    createJob: limitJobsPerRun(config.createJob, {
      questId,
      limit,
      slots,
      logger,
      logTag: '[AgentVideo]',
      refusal: {
        ok: false,
        status: 403,
        code: 'clip_limit_reached',
        message: `This run has already started its limit of ${limit} video clip${limit === 1 ? '' : 's'}. Do not retry; tell the user the limit was reached.`,
      },
    }),
  };
}

/**
 * Null means the tool is not offered: not in the toolbelt, an API-key run (same exclusion as chat), no Quest to count on
 * or attach the clip card to, a cap of 0, no usable video model, or a failed read (fail closed).
 */
export async function buildAgentVideoToolConfig(
  { userId, organizationId, apiKeyId, questId, toolEnabled }: BuildAgentVideoToolConfigInput,
  deps: AgentVideoToolConfigDeps
): Promise<VideoToolConfig | null> {
  if (!toolEnabled || apiKeyId || !questId) return null;
  try {
    const limit = await deps.resolveClipLimit({ userId, organizationId });
    if (limit <= 0) return null;
    const base = await deps.buildBaseConfig(userId);
    return base && limitVideoClipsPerRun(base, { questId, limit, slots: deps.slots, logger: deps.logger });
  } catch (error) {
    deps.logger.warn('[AgentVideo] could not build the video tool config; tool not offered this invocation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function getAgentVideoToolConfigDeps(logger: Logger): AgentVideoToolConfigDeps {
  return {
    buildBaseConfig: userId =>
      buildVideoToolConfig(userId, { availability: getVideoJobDeps(), createDeps: getCreateVideoJobDeps() }),
    resolveClipLimit: resolveAgentRunLimit(AGENT_VIDEO_CLIPS_SETTING_KEY, logger),
    slots: questGenerationSlots('video'),
    logger,
  };
}
