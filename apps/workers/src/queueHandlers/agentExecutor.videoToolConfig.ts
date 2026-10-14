/**
 * The `video_generation` tool config for agent-mode runs (the parent and its in-process subagents).
 *
 * Chat builds the same base config (questProcessor.getVideoToolConfigResolver); agent mode adds a
 * per-run clip cap on top, because one run can fan out across in-process subagents and many
 * iterations. The cap is the `agentVideoClipsPerRun` setting (platform default, org override; 0
 * removes the tool) and is counted atomically on the run's Quest. Lambda-dispatched subagents get no
 * native tools at all today (processSubagentDispatch passes no `enabledTools`), so they get no video
 * either; giving them native tools must reuse this config, keyed on the shared `linkedQuestId`.
 * Video jobs hold and settle their own credits, so nothing here touches agentExecutor.billing.ts.
 */
import { questRepository, adminSettingsRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import type { Logger } from '@bike4mind/observability';
import { getCreateVideoJobDeps, getVideoJobDeps } from '@server/generationJobs/wiring';
import { buildVideoToolConfig } from '@server/videoGenerations/buildVideoToolConfig';

export const AGENT_VIDEO_CLIPS_SETTING_KEY = 'agentVideoClipsPerRun' as const;

export type AgentVideoClipSlots = {
  /** Atomically claims a slot; false once `limit` are claimed for this Quest. */
  claim(questId: string, limit: number): Promise<boolean>;
  release(questId: string): Promise<void>;
};

export type AgentVideoToolConfigDeps = {
  buildBaseConfig(userId: string): Promise<VideoToolConfig | null>;
  resolveClipLimit(caller: { userId: string; organizationId?: string }): Promise<number>;
  slots: AgentVideoClipSlots;
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
  slots: AgentVideoClipSlots;
  logger: Logger;
};

/**
 * Wraps `createJob` so a call past the cap returns a tool error instead of starting a job. A slot is
 * given back only when createJob RETURNED without starting a clip: a refusal, or an idempotent replay
 * of a job this run already started (`created: false`). A throw keeps the slot, because createJob can
 * throw after the job is persisted (a failed enqueue whose cleanup also failed), and so can a Lambda
 * killed mid-call: both err toward one clip fewer, never one too many.
 */
export function limitVideoClipsPerRun(
  config: VideoToolConfig,
  { questId, limit, slots, logger }: LimitVideoClipsOptions
): VideoToolConfig {
  return {
    ...config,
    createJob: async input => {
      if (!(await slots.claim(questId, limit))) {
        return {
          ok: false,
          status: 403,
          code: 'clip_limit_reached',
          message: `This run has already started its limit of ${limit} video clip${limit === 1 ? '' : 's'}. Do not retry; tell the user the limit was reached.`,
        };
      }
      const result = await config.createJob(input);
      if (!(result.ok && result.created)) {
        await slots.release(questId).catch(error =>
          logger.warn('[AgentVideo] failed to release an unused clip slot; the run keeps one fewer', {
            questId,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      return result;
    },
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

/**
 * Writes the run's new video job ids onto its Quest as each job is created, like chat, so the clip
 * card survives a checkpoint continuation (whose in-memory run state starts empty). Best-effort: the
 * job itself already exists and bills regardless.
 */
export async function attachVideoJobsToRunQuest(
  videoJobIds: readonly string[] | undefined,
  questId: string | undefined,
  quests: { addVideoJobIds(questId: string, jobIds: string[]): Promise<void> },
  logger: Logger
): Promise<void> {
  if (!videoJobIds?.length || !questId) return;
  await quests.addVideoJobIds(questId, [...videoJobIds]).catch(error =>
    logger.warn('[AgentVideo] failed to attach video jobs to the run quest', {
      questId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

/** Production deps. The run's organizationId is membership-checked at run start (see agentExecutor toolDeps). */
export function getAgentVideoToolConfigDeps(logger: Logger): AgentVideoToolConfigDeps {
  return {
    buildBaseConfig: userId =>
      buildVideoToolConfig(userId, { availability: getVideoJobDeps(), createDeps: getCreateVideoJobDeps() }),
    resolveClipLimit: async caller => {
      const { value } = await scopedSettingsService.resolveScopedSetting(
        AGENT_VIDEO_CLIPS_SETTING_KEY,
        scopedSettingsService.scopeForCaller(caller),
        { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
        { logger }
      );
      return value;
    },
    slots: {
      claim: (questId, limit) => questRepository.claimAgentVideoClip(questId, limit),
      release: questId => questRepository.releaseAgentVideoClip(questId),
    },
    logger,
  };
}
