import { WebClient } from '@slack/web-api';
import type { IUserDocument, ISlackDevWorkspaceRepository, IOrgSlackWorkspaceRepository } from '@bike4mind/common';
import { getSlackDb, getSlackDeps } from './di/registry';

type UserLookup = {
  findById(id: string): { select(fields: string): Promise<IUserDocument | null> };
};

// `conversations.members` pages 200 at a time, so a large channel costs up to 50 calls per
// delivery. Positive results are cached briefly; a negative or failed check is always re-asked.
const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
const verifiedMemberships = new Map<string, number>();

function membershipIsCached(key: string): boolean {
  const expiresAt = verifiedMemberships.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    verifiedMemberships.delete(key);
    return false;
  }
  return true;
}

function rememberMembership(key: string): void {
  if (verifiedMemberships.size >= 1000) {
    for (const [entry, expiresAt] of verifiedMemberships) {
      if (expiresAt <= Date.now()) verifiedMemberships.delete(entry);
    }
  }
  verifiedMemberships.set(key, Date.now() + MEMBERSHIP_CACHE_TTL_MS);
}

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
  const membershipKey = `${slackTeamId}:${channelId}:${slackUserId}`;
  if (membershipIsCached(membershipKey)) return { botToken, channel: channelId, slackTeamId };

  let cursor: string | undefined;
  do {
    const response = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
    if (!response.ok) throw new Error('Unable to verify Slack channel membership');
    if (response.members?.includes(slackUserId)) {
      rememberMembership(membershipKey);
      return { botToken, channel: channelId, slackTeamId };
    }
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
  } while (cursor);
  throw new Error('You must be a member of the notification channel');
}
