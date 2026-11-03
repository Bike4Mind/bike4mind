import type { Request } from 'express';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_ORG_OWNER_CODE,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type IUserDeletion,
} from '@bike4mind/common';
import {
  McpServer,
  User,
  mcpConnectionRepository,
  oauthGrantRepository,
  oauthRefreshTokenRepository,
  organizationRepository,
  userApiKeyRepository,
} from '@bike4mind/database';
import { withdrawAuthorListings } from '@bike4mind/server-utils/skillMarket/market';
import { commitWithSessionEnd } from '@server/auth/endUserSessions';
import {
  cancelAccountSubscriptions,
  type AccountSubscriptionCancellation,
} from '@server/billing/cancelAccountSubscriptions';
import {
  readUserIntegrationGrants,
  revokeIntegrationGrants,
  type UserIntegrationGrants,
} from '@server/services/purgeDeletedUserData';
import { purgeUserPublishedArtifacts } from '@server/services/publish/purgeUserPublishedArtifacts';
import { logAuthAudit } from '@server/utils/authAudit';
import { sendAccountDeletionScheduledEmail } from './accountDeletionEmail';

const DAY_MS = 24 * 60 * 60 * 1000;

// any: express Request generics vary across call sites; only user, logger and request metadata are read.
type DeletionRequest = Request<any, any, any, any, any>;

export type OwnedOrganization = { id: string; name: string };

/** The organizations the user is billing owner of; each must be transferred or deleted first. */
export async function findOwnedOrganizations(userId: string): Promise<OwnedOrganization[]> {
  const orgs = await organizationRepository.find({ userId, deletedAt: null, personal: { $ne: true } });
  return orgs.map(org => ({ id: String(org.id), name: org.name }));
}

export type AccountDeletionLockdown = {
  deletion: IUserDeletion;
  subscriptions: AccountSubscriptionCancellation;
};

/**
 * Schedule the caller's account for deletion and lock it down. The deletion stamp, the sign-out of
 * every device and the credential revokes (API keys, OAuth app grants, integration and MCP
 * credentials) commit in one transaction, so the account is never frozen with a credential left live.
 * The remote and best-effort steps (provider grant revokes, subscription cancel, taking published
 * pages and Skill Market listings offline, the email) run after commit and never fail the request.
 * Cancelling restores access only: nothing revoked or taken offline here comes back.
 */
export async function requestAccountDeletion(req: DeletionRequest, now = new Date()): Promise<AccountDeletionLockdown> {
  const userId: string = req.user.id;
  if ((req.user as { impersonatedBy?: string }).impersonatedBy) {
    throw new ForbiddenError('Account deletion cannot be requested while impersonating a user.');
  }

  const ownedOrganizations = await findOwnedOrganizations(userId);
  if (ownedOrganizations.length > 0) {
    throw new ConflictError('Transfer or delete the organizations you own before deleting your account.', {
      code: ACCOUNT_DELETION_ORG_OWNER_CODE,
      organizations: ownedOrganizations,
    });
  }

  const deletion: IUserDeletion = {
    requestedAt: now,
    scheduledFor: new Date(now.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS),
    source: 'self',
  };

  let integrationGrants: UserIntegrationGrants | null = null;
  const stamped = await commitWithSessionEnd(
    req,
    async () => {
      const updated = await User.findOneAndUpdate(
        { _id: userId, deletion: null },
        { $set: { deletion } },
        { new: true, projection: { email: 1 } }
      ).lean<{ email?: string }>();
      if (!updated) return null;

      // Read before the clear below: the provider revokes after commit need the stored tokens.
      integrationGrants = await readUserIntegrationGrants(userId);
      await User.updateOne(
        { _id: userId },
        {
          $set: { googleDrive: null, atlassianConnect: null, notionConnect: null, blogIntegration: null },
          $unset: {
            'slackSettings.slackUserId': 1,
            'slackSettings.slackTeamId': 1,
            'slackSettings.slackUserToken': 1,
            'slackSettings.slackUserScopes': 1,
            'slackSettings.githubNotifications': 1,
          },
        }
      );
      await McpServer.deleteMany({ userId });
      await mcpConnectionRepository.deleteAllForUser(userId);
      await userApiKeyRepository.deactivateAllByUserId(userId);
      await oauthRefreshTokenRepository.revokeAllForUser(userId);
      for (const grant of await oauthGrantRepository.listActiveByUser(userId)) {
        await oauthGrantRepository.revoke(userId, grant.clientId);
      }
      return updated;
    },
    updated => (updated ? { userId, reason: 'account_deletion_requested' } : undefined)
  );
  if (!stamped) throw new ConflictError('This account is already scheduled for deletion.');

  await logAuthAudit(req, {
    userId,
    event: 'account_deletion_requested',
    metadata: { scheduledFor: deletion.scheduledFor.toISOString() },
  });

  const logger = req.logger;
  if (integrationGrants) await revokeIntegrationGrants(userId, integrationGrants, logger, 'deletion-pending user');

  // Never throws; failures are logged at error inside.
  const subscriptions = await cancelAccountSubscriptions({ userId, reason: 'deletion_requested' }, logger);

  try {
    await purgeUserPublishedArtifacts(userId, { deletedBy: userId, logger });
  } catch (err) {
    logger.error(`Failed to take down published artifacts for deletion-pending user ${userId}: ${String(err)}`);
  }
  try {
    await withdrawAuthorListings(userId);
  } catch (err) {
    logger.error(`Failed to withdraw Skill Market listings for deletion-pending user ${userId}: ${String(err)}`);
  }

  if (stamped.email) {
    try {
      await sendAccountDeletionScheduledEmail(stamped.email, deletion.scheduledFor);
    } catch (err) {
      logger.error(`Failed to send the deletion-scheduled email for user ${userId}: ${String(err)}`);
    }
  }

  return { deletion, subscriptions };
}

/** Clear the caller's pending deletion, restoring access. Throws NotFoundError when none is pending. */
export async function cancelAccountDeletion(req: DeletionRequest): Promise<void> {
  const userId: string = req.user.id;
  if ((req.user as { impersonatedBy?: string }).impersonatedBy) {
    throw new ForbiddenError('Account deletion cannot be cancelled while impersonating a user.');
  }
  const result = await User.updateOne({ _id: userId, deletion: { $ne: null } }, { $unset: { deletion: 1 } });
  if (result.modifiedCount === 0) throw new NotFoundError('This account is not scheduled for deletion.');
  await logAuthAudit(req, { userId, event: 'account_deletion_cancelled' });
}
