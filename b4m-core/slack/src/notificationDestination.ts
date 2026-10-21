import { WebClient } from '@slack/web-api';
import type { IUserDocument, ISlackDevWorkspaceRepository, IOrgSlackWorkspaceRepository } from '@bike4mind/common';
import { getSlackDb, getSlackDeps } from './di/registry';

type UserLookup = {
  findById(id: string): { select(fields: string): Promise<IUserDocument | null> };
};

/** Resolve and reauthorize at delivery time, including subscriptions saved before verification. */
export async function resolveNotificationDestination(userId: string, channelId?: string) {
  const db = getSlackDb();
  const user = await (db.User as UserLookup).findById(userId).select('slackSettings');
  const { slackUserId, slackTeamId } = user?.slackSettings ?? {};
  if (!slackUserId || !slackTeamId) throw new Error('Connect with Slack to verify your identity first');

  const systemWorkspace = await (
    db.slackDevWorkspaceRepository as ISlackDevWorkspaceRepository
  ).findBySlackTeamIdWithToken(slackTeamId);
  const workspace =
    systemWorkspace ??
    (await (db.orgSlackWorkspaceRepository as IOrgSlackWorkspaceRepository | undefined)?.findBySlackTeamIdWithToken(
      slackTeamId
    ));
  const botToken = getSlackDeps().tokenEncryption.decryptToken(workspace?.slackBotToken);
  if (!botToken) throw new Error('The linked Slack workspace is unavailable');

  if (!channelId) return { botToken, channel: slackUserId, slackTeamId };
  if (!/^[CG][A-Z0-9]+$/.test(channelId)) throw new Error('Choose a Slack channel in your linked workspace');

  const client = new WebClient(botToken);
  let cursor: string | undefined;
  do {
    const response = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
    if (!response.ok) throw new Error('Unable to verify Slack channel membership');
    if (response.members?.includes(slackUserId)) return { botToken, channel: channelId, slackTeamId };
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  throw new Error('You must be a member of the notification channel');
}
