import { MUSIC_MODEL_IDS } from '@bike4mind/common';
import { createMusicJob, type CreateMusicJobDeps } from '@bike4mind/services/musicJobs';
import type { MusicToolConfig } from '@bike4mind/services/llm/tools';
import { listUsableMusicModels, type MusicModelAvailabilityDeps } from './listUsableMusicModels';

type BuildMusicToolConfigDeps = {
  availability: MusicModelAvailabilityDeps;
  createDeps: CreateMusicJobDeps;
};

/**
 * Null when the caller has no usable music model, so the tool is not offered.
 * The tool fills user.organizationId from the turn's already-resolved organization (the one the chat bills),
 * so the job bills the same owner without re-resolving it here.
 */
export async function buildMusicToolConfig(
  userId: string,
  deps: BuildMusicToolConfigDeps
): Promise<MusicToolConfig | null> {
  const usable = await listUsableMusicModels(userId, deps.availability);
  const usableIds = new Set<string>(usable.map(model => model.id));
  const usableModels = MUSIC_MODEL_IDS.filter(id => usableIds.has(id));
  if (usableModels.length === 0) return null;
  return {
    usableModels,
    createJob: input => createMusicJob(input, deps.createDeps),
    findJob: jobId => deps.createDeps.repository.findById(jobId),
  };
}
