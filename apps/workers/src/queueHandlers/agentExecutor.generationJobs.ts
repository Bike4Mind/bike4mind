import type { GenerationJobRef } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * Writes the run's new generation jobs (video, music) onto its Quest as each job is created, like
 * chat, so the job card survives a checkpoint continuation (whose in-memory run state starts empty).
 * Best-effort: the job itself already exists and bills regardless.
 */
export async function attachGenerationJobsToRunQuest(
  jobs: readonly GenerationJobRef[] | undefined,
  questId: string | undefined,
  quests: { addGenerationJobs(questId: string, jobs: GenerationJobRef[]): Promise<void> },
  logger: Logger
): Promise<void> {
  if (!jobs?.length || !questId) return;
  await quests.addGenerationJobs(questId, [...jobs]).catch(error =>
    logger.warn('[AgentGenerationJobs] failed to attach generation jobs to the run quest', {
      questId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

/**
 * Attaches the run's new generation jobs to its Quest, then pushes them to the client on a `progress` frame so the
 * job cards render while the run is live. The agent path has no streamed quest (chat's carries `generationJobs`), and
 * the quest change-stream is not a reliable delivery path for the optimistic bubble. The frame goes out even when
 * the quest write failed: the job exists and its card can still poll it.
 */
export async function publishRunGenerationJobs({
  jobs,
  questId,
  executionId,
  questRepository,
  sendWs,
  logger,
}: {
  jobs: readonly GenerationJobRef[] | undefined;
  questId: string | undefined;
  executionId: string;
  questRepository: { addGenerationJobs(questId: string, jobs: GenerationJobRef[]): Promise<void> };
  sendWs: (action: string, payload: Record<string, unknown>) => Promise<void>;
  logger: Logger;
}): Promise<void> {
  if (!jobs?.length) return;
  await attachGenerationJobsToRunQuest(jobs, questId, questRepository, logger);
  await sendWs('progress', {
    executionId,
    ...(questId ? { questId } : {}),
    generationJobs: jobs.map(({ id, kind }) => ({ id, kind })),
  });
}
