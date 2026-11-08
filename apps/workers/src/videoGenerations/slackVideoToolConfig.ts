import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import { withJobDelivery } from './withJobDelivery';

export const SLACK_VIDEO_DELIVERY_NOTE =
  'The finished video will be posted to this Slack thread automatically; tell the user it is being made and roughly how long it takes.';

export type PendingSlackNotification = {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
};

type SlackVideoToolConfigDeps = {
  /** The quest's pending Slack notification; null once it has been delivered and cleared. */
  findSlackNotification(questId: string): Promise<PendingSlackNotification | null>;
  buildConfig(userId: string): Promise<VideoToolConfig | null>;
};

/**
 * A job's result arrives minutes later, after the quest's slackNotification is cleared, so the target is stamped on
 * the job here. Without a pending Slack notification there is nowhere to deliver to, so the tool is not offered.
 */
export async function buildSlackVideoToolConfig(
  questId: string,
  userId: string,
  deps: SlackVideoToolConfigDeps
): Promise<VideoToolConfig | null> {
  const notification = await deps.findSlackNotification(questId);
  if (!notification) return null;
  const { workspaceId, channelId, messageTs, threadTs } = notification;
  return withJobDelivery(
    await deps.buildConfig(userId),
    { kind: 'slack', workspaceId, channelId, threadTs: threadTs || messageTs },
    SLACK_VIDEO_DELIVERY_NOTE
  );
}
