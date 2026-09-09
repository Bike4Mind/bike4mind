import { FabFileSourceType, type IFabFileDocument } from '@bike4mind/common';
import { dataLakeRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { SlackClient } from '@bike4mind/slack';
import { Logger } from '@bike4mind/observability';
import { decryptToken } from '@server/security/tokenEncryption';

/**
 * Posts a threaded Slack reply when a Slack-ingested FabFile finishes indexing - closing the
 * "wait for it to become searchable, then silence" gap #2027/#2029 was filed for. Called from
 * `fabFileVectorize.ts`'s `isFileVectorized` branch, the same place the browser websocket push
 * already fires; the CALLER wraps this in `.catch(...)`, same as that push, so a failed Slack post
 * never fails or retries vectorization.
 *
 * Resolution chain, since `sourceMetadata: { channel, messageTs }` alone cannot say WHICH Slack
 * workspace/bot token to post with: `sourceMetadata.teamId` (stamped at ingest time - see
 * `dataLakeFileIngest.ts`/`dataLakeLinkIngest.ts`) is the SAME team the message actually arrived
 * on, resolved the same two ways `events.ts` resolves an inbound event - dev-OAuth workspace
 * first, org workspace second - so the token always matches the channel id it is posting to.
 * `fabFile.tags` -> lake -> `organizationId` -> `orgSlackWorkspaceRepository
 * .findByOrganizationIdWithToken` is kept ONLY as a last-resort fallback for files ingested before
 * `teamId` was stamped: it can resolve the wrong workspace for a dev-OAuth install or a user who
 * belongs to more than one org, which is exactly the bug this chain was rewritten to fix.
 * `fabFile.batchId` is NOT usable as a shortcut here - neither Slack ingest path
 * (`dataLakeFileIngest.ts`/`dataLakeLinkIngest.ts`) ever sets it, so that field is always empty
 * for a Slack-origin file.
 *
 * Every early return below (non-Slack origin, no channel/messageTs, no resolvable workspace) is a
 * deliberate skip, not an error: this is cosmetic polish layered on top of vectorization, and must
 * never surface as a failure there.
 */
export async function notifySlackIndexingComplete(
  fabFile: Pick<IFabFileDocument, 'id' | 'fileName' | 'sourceType' | 'sourceMetadata' | 'tags'>,
  logger: Logger
): Promise<void> {
  if (fabFile.sourceType !== FabFileSourceType.SLACK) return;

  const channel = fabFile.sourceMetadata?.channel;
  const messageTs = fabFile.sourceMetadata?.messageTs;
  if (typeof channel !== 'string' || typeof messageTs !== 'string') return;

  const token = await resolveSlackBotToken(fabFile, logger);
  if (!token) return;

  const slackClient = new SlackClient(token, logger);
  await slackClient.sendMessage({
    channel,
    threadTs: messageTs,
    text: `"${fabFile.fileName}" finished indexing and is now searchable.`,
  });
}

/**
 * Resolves the bot token to post with. Prefers `sourceMetadata.teamId` (the workspace the message
 * actually arrived on); falls back to the older tags->lake->org chain only when no `teamId` is on
 * file, for files ingested before that stamp existed.
 */
async function resolveSlackBotToken(
  fabFile: Pick<IFabFileDocument, 'id' | 'sourceMetadata' | 'tags'>,
  logger: Logger
): Promise<string | null> {
  const teamId = fabFile.sourceMetadata?.teamId;
  if (typeof teamId === 'string' && teamId) {
    const devWorkspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
    if (devWorkspace?.slackBotToken) return decryptToken(devWorkspace.slackBotToken);

    const orgWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
    if (orgWorkspace?.slackBotToken) return decryptToken(orgWorkspace.slackBotToken);

    // Deliberately does NOT fall back to the lake/org chain here - see the header. Still worth a
    // warn: a stamped teamId with no matching workspace is a real signal (uninstalled workspace,
    // rotated token) that would otherwise show up only as a silently-missing notification.
    logger.warn(`FabFile ${fabFile.id} has sourceMetadata.teamId ${teamId} but no matching Slack workspace was found`);
    return null;
  }

  logger.warn(`FabFile ${fabFile.id} has no sourceMetadata.teamId; falling back to tags->lake->org resolution`);
  return resolveSlackBotTokenViaLakeOrg(fabFile, logger);
}

/** Legacy fallback for files ingested before `sourceMetadata.teamId` was stamped. See the header above. */
async function resolveSlackBotTokenViaLakeOrg(
  fabFile: Pick<IFabFileDocument, 'id' | 'tags'>,
  logger: Logger
): Promise<string | null> {
  const tagNames = (fabFile.tags ?? []).map(t => t.name);
  if (tagNames.length === 0) return null;

  const lakes = await dataLakeRepository.findByDatalakeTags(tagNames);
  if (lakes.length === 0) return null;
  // Rare in practice (a single `@datalake add` targets exactly one lake) but possible if a file's
  // tags span more than one lake - take the first rather than guessing which the user meant.
  if (lakes.length > 1) {
    logger.warn(
      `FabFile ${fabFile.id} matches ${lakes.length} lake tags; using the first for the Slack indexing notification`
    );
  }

  const organizationId = lakes[0].organizationId;
  if (!organizationId) return null; // Org-less (personal) lake: no org Slack workspace to resolve.

  const orgWorkspace = await orgSlackWorkspaceRepository.findByOrganizationIdWithToken(organizationId);
  if (!orgWorkspace?.slackBotToken) return null;

  return decryptToken(orgWorkspace.slackBotToken);
}
