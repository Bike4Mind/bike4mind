import {
  User,
  gitHubLakeAuthGrantRepository,
  mcpConnectionRepository,
  authEventRepository,
  userLimitEventRepository,
  embedConversationRepository,
  hideDeletedAuthorAnnotations,
  integrationRequestRepository,
  abuseEvalSetRepository,
  shadowDetectionRepository,
  campaignWatchRepository,
} from '@bike4mind/database';
import type { IAuthProviders, IMcpConnectionDocument, IUserDocument } from '@bike4mind/common';
import { retainDeletedSignupTraces } from '../auth/signupNetworkLimits';
import { purgeUserPublishedArtifacts } from './publish/purgeUserPublishedArtifacts';
import { withdrawAuthorListings } from '../skillMarket/market';
import { decryptStoredToken, revokeDriveGrant } from '../integrations/google/drive/common';
import { flagConnectionsStoppedByDisconnect } from '../integrations/google/drive/flagConnectionsStoppedByDisconnect';
import { revokeAtlassianGrant } from '../integrations/jira/revokeAtlassianGrant';
import { revokeNotionGrant } from '../integrations/notion/revokeNotionGrant';
import { revokeSlackUserToken } from '../integrations/slack/revokeSlackUserToken';
import { revokeGitHubLakeUserAuthorization } from '../integrations/github/dataLake/githubLakeAuthGrant';
import { revokeAppleGrant } from '../auth/revokeAppleTokens';
import { revokeGitHubSignInGrant } from '../auth/revokeGitHubSignInGrant';
import { revokeConnectionGrant } from '../mcpConnections/oauth/revoke';
import {
  resolveCustomMcpContext,
  resolveOwnHosts,
  type RemoteMcpNetworkOptions,
} from '../mcpConnections/customMcpAccess';

interface MinimalLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * The third-party grants a user holds, read BEFORE the delete: the row and the connections are gone after.
 * Only the Drive and Atlassian fields are required, so a caller can build a partial snapshot.
 */
export type UserIntegrationGrants = Pick<IUserDocument, 'googleDrive' | 'atlassianConnect'> &
  Partial<Pick<IUserDocument, 'notionConnect'>> & {
    slackUserToken?: string | null;
    /** Sign-in identities (Apple, GitHub); left out of the lockdown read, see readUserIntegrationGrants. */
    authProviders?: IAuthProviders[] | null;
    /** The user's own remote MCP connections that signed in with OAuth, with their encrypted tokens. */
    mcpConnections?: IMcpConnectionDocument[];
    /** Encrypted user tokens of live data-lake GitHub App flows. */
    githubLakeTokens?: string[];
  };

/**
 * Read straight from the DB, not a copy captured earlier in the request: a token refresh rotates the
 * stored value, and revoking a stale copy could revoke nothing. `signIn: false` leaves out the Apple
 * and GitHub sign-in identities, which a deletion-pending account keeps so it can sign in and cancel.
 */
export async function readUserIntegrationGrants(
  userId: string,
  { signIn = true }: { signIn?: boolean } = {}
): Promise<UserIntegrationGrants | null> {
  const user = await User.findById(
    userId,
    `googleDrive atlassianConnect notionConnect slackSettings.slackUserToken${signIn ? ' authProviders' : ''}`
  ).lean<UserIntegrationGrants & { slackSettings?: { slackUserToken?: string } }>();
  if (!user) return null;
  const [mcpConnections, lakeGrants] = await Promise.all([
    mcpConnectionRepository.listOAuthWithCredentialsForUser(userId),
    gitHubLakeAuthGrantRepository.listLiveForUser(userId),
  ]);
  return {
    googleDrive: user.googleDrive ?? null,
    atlassianConnect: user.atlassianConnect ?? null,
    notionConnect: user.notionConnect ?? null,
    slackUserToken: user.slackSettings?.slackUserToken ?? null,
    authProviders: signIn ? (user.authProviders ?? null) : null,
    mcpConnections,
    githubLakeTokens: lakeGrants.map(grant => grant.encryptedToken),
  };
}

/** Self-serve completion summary; keep in sync with purgeAccountContent, purgeAccountFiles and the user delete. */
export const PURGED_USER_DATA: readonly string[] = [
  'Your account and profile',
  'Personal notebooks and their messages',
  'Personal files and generated media (except moderation-held content or copies still owned by others)',
  'Personal projects, artifacts, skills and memories',
  'Personal data lakes, agent records and connected-device credentials',
  'API keys, including the AI provider keys you saved',
  'Sign-in sessions and sign-in history',
  'Google Drive, Atlassian, Notion, Slack, GitHub, Sign in with Apple and remote MCP connections',
  'Published pages',
  'Embedded chat conversations',
  'Integration requests',
  'Skill Market listings (copies others already imported stay with them)',
];

/**
 * Remove the data a deleted account leaves behind that nothing else would ever reach. Call it
 * from every path that deletes a user, AFTER the delete has been authorized and committed.
 *
 * Each step is best-effort and independent: the account is already gone, so one failure must
 * not skip the others or surface as an error a retry cannot fix. Every step is idempotent, so
 * re-running this for the same id is safe. Backstops for a failed step: the embed collection's
 * TTL index, the publish serve route refusing artifacts whose owner no longer exists, and the
 * orphan backfill (packages/scripts/src/backfillOrphanedPublishedArtifacts.ts) for annotations.
 */
export async function purgeDeletedUserData(
  userId: string,
  {
    deletedBy,
    logger,
    integrationGrants,
  }: { deletedBy: string; logger: MinimalLogger; integrationGrants: UserIntegrationGrants | null }
): Promise<void> {
  try {
    await embedConversationRepository.deleteAllForUser(userId);
  } catch (err) {
    logger.error(`Failed to purge embed conversations for deleted user ${userId}: ${String(err)}`);
  }

  try {
    await integrationRequestRepository.deleteAllForUser(userId);
  } catch (err) {
    logger.error(`Failed to purge integration requests for deleted user ${userId}: ${String(err)}`);
  }

  try {
    await purgeUserPublishedArtifacts(userId, { deletedBy, logger });
  } catch (err) {
    logger.error(`Failed to purge published artifacts for deleted user ${userId}: ${String(err)}`);
  }

  // Importers keep their copies, as with an author's own withdraw; the listings just leave the market.
  try {
    const withdrawn = await withdrawAuthorListings(userId);
    logger.info(`Withdrew ${withdrawn} Skill Market listing(s) of deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to withdraw Skill Market listings for deleted user ${userId}: ${String(err)}`);
  }

  // After the artifact purge, so this only catches what the user wrote on pages that stay live.
  try {
    const hidden = await hideDeletedAuthorAnnotations(userId);
    logger.info(`Hid ${hidden} annotation(s) written by deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to hide annotations for deleted user ${userId}: ${String(err)}`);
  }

  // Hashed first, so deleting accounts does not reset the per-network signup caps. A failure here
  // still deletes the raw rows below: dropping the IPs outranks keeping the count.
  // If the trace is kept but that delete fails, the account counts twice until its trace expires
  // (an over-count, so the cap fails closed).
  try {
    const retained = await retainDeletedSignupTraces(userId);
    if (retained) logger.info(`Kept ${retained} hashed signup trace(s) of deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to keep signup traces for deleted user ${userId}: ${String(err)}`);
  }

  // The signup/login network rows hold raw IPs: deleted with the account, not left to their TTL.
  try {
    const deleted = await authEventRepository.deleteAllForUser(userId);
    logger.info(`Deleted ${deleted} auth event(s) of deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to delete auth events for deleted user ${userId}: ${String(err)}`);
  }

  // Limit hits feed only the admin timeline of this account.
  try {
    const deleted = await userLimitEventRepository.deleteAllForUser(userId);
    logger.info(`Deleted ${deleted} limit event(s) of deleted user ${userId}`);
  } catch (err) {
    logger.error(`Failed to delete limit events for deleted user ${userId}: ${String(err)}`);
  }

  // Shadow detections name the account (and a signup-burst one holds its raw IP): the user leaves every
  // record, and a record left with no one to grade goes with them.
  try {
    const deleted = await shadowDetectionRepository.removeUser(userId);
    logger.info(`Removed deleted user ${userId} from shadow detections (${deleted} record(s) deleted)`);
  } catch (err) {
    logger.error(`Failed to remove deleted user ${userId} from shadow detections: ${String(err)}`);
  }

  try {
    await campaignWatchRepository.removeUser(userId);
  } catch (err) {
    logger.error(`Failed to remove deleted user ${userId} from campaign watches: ${String(err)}`);
  }

  // Evaluation sets hold the account as a labelled example: the example leaves every set.
  try {
    const changed = await abuseEvalSetRepository.removeUser(userId);
    logger.info(`Removed deleted user ${userId} from ${changed} evaluation set(s)`);
  } catch (err) {
    logger.error(`Failed to remove deleted user ${userId} from evaluation sets: ${String(err)}`);
  }

  // Last: the revokes call out to the providers, and a slow provider must not cost the local steps above.
  if (integrationGrants) {
    await revokeIntegrationGrants(userId, integrationGrants, logger);
  }
}

/**
 * Our copy of the credentials is gone (or about to be), but the grants stay live at the provider until
 * revoked. Same policy as the profile disconnects: revoke, then flag the Drive connections that were
 * syncing on the grant (org ones copy the user's refresh token) so they stop visibly. Best-effort: each
 * provider runs on its own, so one failing or stalling never skips another. `subject` labels the user
 * in the log lines.
 */
export async function revokeIntegrationGrants(
  userId: string,
  {
    googleDrive,
    atlassianConnect,
    notionConnect,
    slackUserToken,
    authProviders,
    mcpConnections,
    githubLakeTokens,
  }: UserIntegrationGrants,
  logger: MinimalLogger,
  subject = 'deleted user'
): Promise<void> {
  const context = `${subject} ${userId}`;
  const step = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err) {
      logger.error(`Failed to ${label} for ${context}: ${String(err)}`);
    }
  };

  await Promise.all([
    step('revoke the Atlassian grant', async () => {
      // Both: Atlassian does not document whether revoking the refresh token also kills issued access tokens.
      await revokeAtlassianGrant(atlassianConnect?.refreshToken, context);
      await revokeAtlassianGrant(atlassianConnect?.accessToken, context);
    }),
    googleDrive &&
      step('flag the Drive connections stopped by the revoke', async () => {
        // The refresh token when there is one: revoking it ends the whole grant, not just one access token.
        await revokeDriveGrant(googleDrive.refreshToken || googleDrive.accessToken, context);
        const affected = await flagConnectionsStoppedByDisconnect(userId, decryptStoredToken(googleDrive.refreshToken));
        logger.info(
          `Flagged ${affected.affectedOrgConnections} org and ${affected.affectedPersonalConnections} personal Drive connection(s) for ${context}`
        );
      }),
    notionConnect && step('revoke the Notion grant', () => revokeNotionGrant(notionConnect.accessToken, context)),
    slackUserToken && step('revoke the Slack user token', () => revokeSlackUserToken(slackUserToken, context)),
    authProviders && step('revoke the Sign in with Apple grant', () => revokeAppleGrant(authProviders)),
    authProviders && step('revoke the GitHub sign-in grant', () => revokeGitHubSignInGrant(authProviders, context)),
    ...(githubLakeTokens ?? []).map(token =>
      step('revoke the data-lake GitHub App authorization', () => revokeGitHubLakeUserAuthorization(token, context))
    ),
    mcpConnections?.length &&
      step('revoke the remote MCP grants', async () => {
        const network = await mcpRevokeNetwork(userId);
        await Promise.all(mcpConnections.map(connection => revokeConnectionGrant(connection, network)));
      }),
  ]);
}

/** The user's own network policy when it still resolves; the default (own hosts blocked) when it does not. */
async function mcpRevokeNetwork(userId: string): Promise<RemoteMcpNetworkOptions> {
  try {
    return (await resolveCustomMcpContext(userId)).network;
  } catch {
    return { ownHosts: resolveOwnHosts() };
  }
}
