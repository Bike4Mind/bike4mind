import { FabFileSourceType, type IDataLakeDocument, type IFabFileDocument } from '@bike4mind/common';
import { dataLakeRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { SlackClient, escapeSlackMrkdwn } from '@bike4mind/slack';
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
 * Separately, `fabFile.tags` -> lake is ALSO resolved so the message can name the lake per #2029's
 * acceptance criteria - but only AFTER a token is confirmed, so a file whose token never resolves
 * (any of the skip paths above) never pays for a lake lookup it won't use. The legacy fallback
 * already needs the same lookup for `organizationId`, so it returns its own resolved lake for the
 * message to reuse rather than querying twice.
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

  const resolved = await resolveSlackBotToken(fabFile, logger);
  if (!resolved) return;

  // The legacy path above already resolved the lake (it needed organizationId); the more common
  // teamId path hasn't, so look it up now - only reached once a token is already confirmed.
  const lake = resolved.lake ?? (await resolveLake(fabFile, logger));

  // `fileName` can come from an attacker-controlled webpage <title> (createByUrl.ts) - escaped so
  // a value like "<!channel> URGENT" cannot post as a real broadcast/mention.
  const fileName = escapeSlackMrkdwn(fabFile.fileName);
  const slackClient = new SlackClient(resolved.token, logger);
  await slackClient.sendMessage({
    channel,
    threadTs: messageTs,
    // #2029 requires naming both the file and the lake; a lake-less lookup (should not happen for
    // a real Slack-origin file, but the ingest paths don't structurally guarantee it) degrades to
    // the file-only wording rather than printing a hole in the sentence.
    text: lake
      ? `"${fileName}" finished indexing in *${lake.name}* and is now searchable.`
      : `"${fileName}" finished indexing and is now searchable.`,
  });
}

/**
 * Looks up the lake this file belongs to via its tags, for the message wording above.
 */
async function resolveLake(
  fabFile: Pick<IFabFileDocument, 'id' | 'tags'>,
  logger: Logger
): Promise<IDataLakeDocument | null> {
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
  return lakes[0];
}

/**
 * Resolves the bot token to post with. Prefers `sourceMetadata.teamId` (the workspace the message
 * actually arrived on); falls back to the older lake->org chain only when no `teamId` is on file,
 * for files ingested before that stamp existed. `lake` on the return value is set only by the
 * legacy path (which had to resolve it anyway); the teamId path leaves it null since it never
 * needed the lookup for the token itself.
 */
async function resolveSlackBotToken(
  fabFile: Pick<IFabFileDocument, 'id' | 'sourceMetadata' | 'tags'>,
  logger: Logger
): Promise<{ token: string; lake: IDataLakeDocument | null } | null> {
  const teamId = fabFile.sourceMetadata?.teamId;
  if (typeof teamId === 'string' && teamId) {
    const devWorkspace = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
    const devToken = devWorkspace?.slackBotToken ? decryptToken(devWorkspace.slackBotToken) : null;
    if (devToken) return { token: devToken, lake: null };

    const orgWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
    const orgToken = orgWorkspace?.slackBotToken ? decryptToken(orgWorkspace.slackBotToken) : null;
    if (orgToken) return { token: orgToken, lake: null };

    // Deliberately does NOT fall back to the lake/org chain here - see the header. Still worth a
    // warn: a stamped teamId with no matching workspace is a real signal (uninstalled workspace,
    // rotated token) that would otherwise show up only as a silently-missing notification.
    logger.warn(`FabFile ${fabFile.id} has sourceMetadata.teamId ${teamId} but no matching Slack workspace was found`);
    return null;
  }

  logger.warn(`FabFile ${fabFile.id} has no sourceMetadata.teamId; falling back to lake->org resolution`);
  return resolveSlackBotTokenViaLakeOrg(fabFile, logger);
}

/** Legacy fallback for files ingested before `sourceMetadata.teamId` was stamped. See the header above. */
async function resolveSlackBotTokenViaLakeOrg(
  fabFile: Pick<IFabFileDocument, 'id' | 'tags'>,
  logger: Logger
): Promise<{ token: string; lake: IDataLakeDocument } | null> {
  const lake = await resolveLake(fabFile, logger);
  if (!lake) return null;

  const organizationId = lake.organizationId;
  if (!organizationId) return null; // Org-less (personal) lake: no org Slack workspace to resolve.

  const orgWorkspace = await orgSlackWorkspaceRepository.findByOrganizationIdWithToken(organizationId);
  const token = orgWorkspace?.slackBotToken ? decryptToken(orgWorkspace.slackBotToken) : null;
  if (!token) return null;

  return { token, lake };
}
