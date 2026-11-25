import { findOwnGenerationJob } from './findOwnGenerationJob';

/**
 * The recent-images note's job outputs: each listed job the caller requested that finished with a file. Through
 * findOwnGenerationJob, so a job id from another user's quest resolves to nothing. The ids are capped upstream
 * (MAX_RECENT_GENERATED_IMAGES), so one lookup each stays cheap. Shared by web chat (questProcessor) and the agent
 * executor, so both notes list the same files.
 */
export const resolveImageJobFiles = async ({
  jobIds,
  userId,
}: {
  jobIds: string[];
  userId: string;
}): Promise<{ jobId: string; fileId: string }[]> => {
  const jobs = await Promise.all(jobIds.map(id => findOwnGenerationJob(id, userId, 'image')));
  return jobs.flatMap(job => {
    const fileId = job?.state === 'succeeded' ? job.payload.output?.fileId : undefined;
    return job && fileId ? [{ jobId: job.id, fileId }] : [];
  });
};
