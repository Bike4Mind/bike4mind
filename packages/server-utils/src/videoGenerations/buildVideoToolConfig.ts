import { VIDEO_MODEL_IDS } from '@bike4mind/common';
import { createVideoJob, type CreateVideoJobDeps } from '@bike4mind/services/videoJobs';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import { listUsableVideoModels, type VideoModelAvailabilityDeps } from './listUsableVideoModels';

type BuildVideoToolConfigDeps = {
  availability: VideoModelAvailabilityDeps;
  createDeps: CreateVideoJobDeps;
};

/**
 * Null when the caller has no usable video model, so the tool is not offered.
 * The tool fills user.organizationId from the turn's already-resolved organization (the one the chat bills),
 * so the job bills the same owner without re-resolving it here.
 */
export async function buildVideoToolConfig(
  userId: string,
  deps: BuildVideoToolConfigDeps
): Promise<VideoToolConfig | null> {
  const usable = await listUsableVideoModels(userId, deps.availability);
  const usableIds = new Set<string>(usable.map(model => model.id));
  const usableModels = VIDEO_MODEL_IDS.filter(id => usableIds.has(id));
  if (usableModels.length === 0) return null;
  return {
    usableModels,
    createJob: input => createVideoJob(input, deps.createDeps),
  };
}
