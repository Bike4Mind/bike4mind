import type { ISessionDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  buildRecentGeneratedImagesNote,
  resolveRecentImageJobFiles,
  type ImageJobFilesResolver,
} from '@bike4mind/services/llm';
import { fetchAgentRecentGeneratedImages } from '@bike4mind/utils';

type QuestHistoryRepository = Parameters<typeof fetchAgentRecentGeneratedImages>[2]['db']['quests'];

export type AgentRecentImagesNoteInput = {
  session: Pick<ISessionDocument, 'id' | 'userId'>;
  callerId: string;
  /** Names of the tools the agent was actually built with (after availability and org policy). */
  toolNames: readonly string[];
  questCount: number;
  questHistory: QuestHistoryRepository;
  resolveImageJobFiles: ImageJobFilesResolver;
  logger: Pick<Logger, 'warn'>;
};

/**
 * The agent run's "Recently generated images" note, the same one ChatCompletionProcess adds on the chat path
 * (see buildRecentGeneratedImagesNote). The agent seeds text-only history, so without it a follow-up such as
 * "make it blue" has no id to pass to edit_image. Undefined when there is nothing to list or no tool takes the ids.
 */
export async function buildAgentRecentImagesNote({
  session,
  callerId,
  toolNames,
  questCount,
  questHistory,
  resolveImageJobFiles,
  logger,
}: AgentRecentImagesNoteInput): Promise<string | undefined> {
  const editImageAvailable = toolNames.includes('edit_image');
  const videoGenerationAvailable = toolNames.includes('video_generation');
  if (!editImageAvailable && !videoGenerationAvailable) return undefined;
  if (session.userId !== callerId) return undefined;

  const { recentGeneratedImages, recentImageJobs } = await fetchAgentRecentGeneratedImages(session, questCount, {
    db: { quests: questHistory },
  });
  const imageJobFiles = await resolveRecentImageJobFiles({
    recentImageJobs,
    resolver: resolveImageJobFiles,
    userId: callerId,
    logger,
  });
  const [note] = buildRecentGeneratedImagesNote({
    images: recentGeneratedImages,
    imageJobFiles,
    editImageAvailable,
    videoGenerationAvailable,
    sessionOwnerId: session.userId,
    callerId,
  });
  return note?.content;
}

/** Appends the note to the caller's per-send system context (ReActAgent folds `context` into messages[0]). */
export function withRecentImagesNote(systemContext: string | undefined, note: string | undefined): string | undefined {
  if (!note) return systemContext;
  return systemContext ? `${systemContext}\n\n${note}` : note;
}
