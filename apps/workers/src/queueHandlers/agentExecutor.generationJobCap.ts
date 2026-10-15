/**
 * The per-run cap shared by the agent-mode generation tools (agentExecutor.videoToolConfig.ts,
 * agentExecutor.musicToolConfig.ts). One run can fan out across in-process subagents and many
 * iterations, so each kind is capped by a setting (platform default, org override; 0 removes the
 * tool) and counted atomically on the run's Quest (QuestRepository.claimAgentGenerationSlot).
 */
import type { GenerationJobKind } from '@bike4mind/common';
import { questRepository, adminSettingsRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';

export type AgentGenerationSlots = {
  /** Atomically claims a slot; false once `limit` are claimed for this Quest. */
  claim(questId: string, limit: number): Promise<boolean>;
  release(questId: string): Promise<void>;
};

export type AgentRunLimitCaller = { userId: string; organizationId?: string };

type CreateJobResult = { ok: true; created: boolean } | { ok: false };

type LimitJobsPerRunOptions<TResult> = {
  questId: string;
  limit: number;
  slots: AgentGenerationSlots;
  logger: Logger;
  /** Prefixes the release-failure warning, e.g. '[AgentVideo]'. */
  logTag: string;
  /** The tool result the model sees once the cap is reached. */
  refusal: TResult;
};

const startedNewJob = (result: CreateJobResult): boolean => result.ok && result.created;

/**
 * Wraps `createJob` so a call past the cap returns `refusal` instead of starting a job. A slot is
 * given back only when createJob RETURNED without starting a job: a refusal, or an idempotent replay
 * of a job this run already started (`created: false`). A throw keeps the slot, because createJob can
 * throw after the job is persisted (a failed enqueue whose cleanup also failed), and so can a Lambda
 * killed mid-call: both err toward one job fewer, never one too many.
 */
export function limitJobsPerRun<TInput, TResult extends CreateJobResult>(
  createJob: (input: TInput) => Promise<TResult>,
  { questId, limit, slots, logger, logTag, refusal }: LimitJobsPerRunOptions<TResult>
): (input: TInput) => Promise<TResult> {
  return async input => {
    if (!(await slots.claim(questId, limit))) return refusal;
    const result = await createJob(input);
    if (!startedNewJob(result)) {
      await slots.release(questId).catch(error =>
        logger.warn(`${logTag} failed to release an unused slot; the run keeps one fewer`, {
          questId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
    return result;
  };
}

/** Production slots for one job kind, counted on the run's Quest. */
export const questGenerationSlots = (kind: GenerationJobKind): AgentGenerationSlots => ({
  claim: (questId, limit) => questRepository.claimAgentGenerationSlot(questId, kind, limit),
  release: questId => questRepository.releaseAgentGenerationSlot(questId, kind),
});

/**
 * Production per-run limit read. The run's organizationId is membership-checked at run start (see agentExecutor toolDeps).
 * Never throws: resolveScopedSetting degrades a settings outage to the wider scope or the coded default, so an outage can
 * lift an org's 0 back to the platform value.
 */
export const resolveAgentRunLimit =
  (key: 'agentVideoClipsPerRun' | 'agentMusicTracksPerRun', logger: Logger) =>
  async (caller: AgentRunLimitCaller): Promise<number> => {
    const { value } = await scopedSettingsService.resolveScopedSetting(
      key,
      scopedSettingsService.scopeForCaller(caller),
      { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository },
      { logger }
    );
    return value;
  };
