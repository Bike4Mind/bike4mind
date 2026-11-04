import type { IGenerationJobDocument, PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import {
  type ConnectionLookup,
  hasLiveConnection,
  isPushDeliveryConfigured,
  truncateForPush,
} from '@server/utils/pushNotifications';

/**
 * `generation_ready` pushes from the generation queue handlers (generationJob.ts, imageGeneration.ts,
 * imageEdit.ts). Neither function throws: each runs after the generation already settled.
 */

type Publish = (event: PushNotificationEvent) => Promise<void>;

export type GenerationJobPushDeps = {
  findJob(jobId: string): Promise<IGenerationJobDocument | null>;
  sessionDeepLink(sessionId: string): string;
  appRootDeepLink(): string;
  publish: Publish;
};

const JOB_TITLES: Record<IGenerationJobDocument['kind'], string> = {
  video: 'Video ready',
  music: 'Song ready',
};

/**
 * For a video or music job the engine just finished. Pushed regardless of websocket presence: these run
 * for minutes, long enough that the requester has usually moved on. Failed and cancelled jobs are not
 * pushed (there is no failure category), and neither is a job with a Slack delivery, which already
 * reports back in its own thread.
 */
export async function publishGenerationJobReadyPush(
  jobId: string,
  deps: GenerationJobPushDeps,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  if (!isPushDeliveryConfigured()) return;
  try {
    const job = await deps.findJob(jobId);
    if (!job || job.state !== 'succeeded' || job.delivery) return;

    const sessionId = job.kind === 'music' ? job.payload.sessionId : undefined;
    const prompt = job.payload.request.prompt?.replace(/\s+/g, ' ').trim();
    await deps.publish({
      userId: job.requestedBy,
      category: 'generation_ready',
      title: JOB_TITLES[job.kind],
      body: prompt ? truncateForPush(prompt, 160) : `Your ${job.kind} is ready.`,
      deepLink: sessionId ? deps.sessionDeepLink(sessionId) : deps.appRootDeepLink(),
      collapseId: `generation:${job.id}`,
      ...(job.questId && { questId: job.questId }),
      ...(sessionId && { sessionId }),
    });
  } catch (error) {
    logger.warn('[Push] generation job push failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type ImageQuestPushDeps = {
  connections: ConnectionLookup;
  findQuest(questId: string): Promise<{ status?: string; images?: unknown[] | null } | null>;
  sessionDeepLink(sessionId: string): string;
  publish: Publish;
};

/**
 * For an image generation or edit quest. These are chat-shaped (seconds, in a notebook), so they take
 * chat's rule: no push while the user has a live websocket, and only for a quest that settled with images.
 */
export async function publishImageQuestReadyPush(
  body: { questId?: unknown; userId?: unknown; sessionId?: unknown },
  operation: 'generate' | 'edit',
  deps: ImageQuestPushDeps,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  const { questId, userId, sessionId } = body;
  if (typeof questId !== 'string' || typeof userId !== 'string' || typeof sessionId !== 'string') return;
  if (!isPushDeliveryConfigured()) return;
  try {
    if (await hasLiveConnection(userId, deps.connections, logger)) return;
    const quest = await deps.findQuest(questId);
    if (!quest || quest.status !== 'done' || !quest.images?.length) return;

    await deps.publish({
      userId,
      category: 'generation_ready',
      title: operation === 'edit' ? 'Image edit ready' : 'Image ready',
      body: quest.images.length > 1 ? `${quest.images.length} images are ready.` : 'Your image is ready.',
      deepLink: deps.sessionDeepLink(sessionId),
      collapseId: `generation:${questId}`,
      questId,
      sessionId,
    });
  } catch (error) {
    logger.warn('[Push] image generation push failed', {
      questId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
