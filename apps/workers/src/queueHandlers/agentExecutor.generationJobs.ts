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
