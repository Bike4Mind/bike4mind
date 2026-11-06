import type { Request } from 'express';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_ORG_OWNER_CODE,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AccountDeletionSource,
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
  withTransaction,
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
import { sendAccountDeletionCancelledEmail, sendAccountDeletionScheduledEmail } from './accountDeletionEmail';

const DAY_MS = 24 * 60 * 60 * 1000;

type DeletionRequest = Request<unknown, unknown, unknown, unknown, Record<string, unknown>>;

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

export type ScheduleAccountDeletionInput = {
  userId: string;
  source: AccountDeletionSource;
  /** When the request was made; the purge date counts from `now`, so the user always gets the full grace window. */
  requestedAt: Date;
  /** The admin acting for the user, recorded on the session-end and auth-audit rows. */
  actorUserId?: string;
  /** Runs in the stamp's transaction after it succeeds; a throw rolls the whole lockdown back. */
  recordInTransaction?: (deletion: IUserDeletion) => Promise<void>;
};

/**
 * Schedule the caller's account for deletion and lock it down. See scheduleAccountDeletion.
 */
export async function requestAccountDeletion(req: DeletionRequest, now = new Date()): Promise<AccountDeletionLockdown> {
  if ((req.user as { impersonatedBy?: string }).impersonatedBy) {
    throw new ForbiddenError('Account deletion cannot be requested while impersonating a user.');
  }
  return scheduleAccountDeletion(req, { userId: req.user.id, source: 'self', requestedAt: now }, now);
}

/**
 * Schedule `userId`'s account for deletion and lock it down. The deletion stamp, the sign-out of
 * every device and the credential revokes (API keys, OAuth app grants, integration and MCP
 * credentials) commit in one transaction, so the account is never frozen with a credential left live.
 * The remote and best-effort steps (provider grant revokes, subscription cancel, taking published
 * pages and Skill Market listings offline, the email) run after commit and never fail the request.
 * Cancelling restores access only: nothing revoked or taken offline here comes back.
 * Callers own the authorization: the self-serve wrapper and the admin endpoint both go through here.
 */
export async function scheduleAccountDeletion(
  req: DeletionRequest,
  { userId, source, requestedAt, actorUserId, recordInTransaction }: ScheduleAccountDeletionInput,
  now = new Date()
): Promise<AccountDeletionLockdown> {
  const ownedOrganizations = await findOwnedOrganizations(userId);
  if (ownedOrganizations.length > 0) {
    throw new ConflictError(
      source === 'self'
        ? 'Transfer or delete the organizations you own before deleting your account.'
        : 'Transfer or delete the organizations this user owns before scheduling deletion.',
      { code: ACCOUNT_DELETION_ORG_OWNER_CODE, organizations: ownedOrganizations }
    );
  }

  const deletion: IUserDeletion = {
    requestedAt,
    scheduledFor: new Date(now.getTime() + ACCOUNT_DELETION_GRACE_DAYS * DAY_MS),
    source,
  };

  const { email, subscriptions } = await lockDownAccount(req, userId, deletion, { actorUserId, recordInTransaction });
  if (email) {
    try {
      await sendAccountDeletionScheduledEmail(email, deletion.scheduledFor, { source });
    } catch (err) {
      req.logger.error(`Failed to send the deletion-scheduled email for user ${userId}: ${String(err)}`);
    }
  }
  return { deletion, subscriptions };
}

/**
 * An admin's data subject erasure of `userId`: the same lockdown as a self-serve request, stamped
 * `source: 'admin'` and due at once, so the purge (completeAccountDeletion.ts) can run immediately.
 * No email goes to the person. Refused while the user owns an organization, or has a deletion pending
 * already (self-serve or admin), which this never overrides.
 */
export async function requestAdminErasure(
  req: DeletionRequest,
  userId: string,
  now = new Date()
): Promise<AccountDeletionLockdown> {
  const ownedOrganizations = await findOwnedOrganizations(userId);
  if (ownedOrganizations.length > 0) {
    throw new ConflictError('Transfer or delete the organizations this user owns before erasing their data.', {
      code: ACCOUNT_DELETION_ORG_OWNER_CODE,
      organizations: ownedOrganizations,
    });
  }
  const deletion: IUserDeletion = { requestedAt: now, scheduledFor: now, source: 'admin', requestedBy: req.user.id };
  const { subscriptions } = await lockDownAccount(req, userId, deletion, { actorUserId: req.user.id });
  return { deletion, subscriptions };
}

/**
 * Stamps `deletion` on a user with none pending and locks the account down. The stamp, the sign-out
 * of every device and the credential revokes commit in one transaction; the remote and best-effort
 * steps run after commit and never fail the request. Throws ConflictError when nothing matched.
 */
async function lockDownAccount(
  req: DeletionRequest,
  userId: string,
  deletion: IUserDeletion,
  { actorUserId, recordInTransaction }: Pick<ScheduleAccountDeletionInput, 'actorUserId' | 'recordInTransaction'>
): Promise<{ email: string | null; subscriptions: AccountSubscriptionCancellation }> {
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
      await recordInTransaction?.(deletion);

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
    updated => (updated ? { userId, reason: 'account_deletion_requested', actorUserId } : undefined)
  );
  if (!stamped) throw new ConflictError('This account is already scheduled for deletion.');

  await logAuthAudit(req, {
    userId,
    event: 'account_deletion_requested',
    actorUserId,
    metadata: { scheduledFor: deletion.scheduledFor.toISOString(), source: deletion.source },
  });

  const logger = req.logger;
  if (integrationGrants) await revokeIntegrationGrants(userId, integrationGrants, logger, 'deletion-pending user');

  // Never throws; failures are logged at error inside.
  const subscriptions = await cancelAccountSubscriptions({ userId, reason: 'deletion_requested' }, logger);

  try {
    await purgeUserPublishedArtifacts(userId, { deletedBy: actorUserId ?? userId, logger });
  } catch (err) {
    logger.error(`Failed to take down published artifacts for deletion-pending user ${userId}: ${String(err)}`);
  }
  try {
    await withdrawAuthorListings(userId);
  } catch (err) {
    logger.error(`Failed to withdraw Skill Market listings for deletion-pending user ${userId}: ${String(err)}`);
  }
  return { email: stamped.email ?? null, subscriptions };
}

/**
 * Clear the caller's pending deletion, restoring access, and mail the deletion-cancelled email.
 * Throws NotFoundError when none is pending, so a repeated cancel sends no second email.
 */
export async function cancelAccountDeletion(req: DeletionRequest): Promise<void> {
  if ((req.user as { impersonatedBy?: string }).impersonatedBy) {
    throw new ForbiddenError('Account deletion cannot be cancelled while impersonating a user.');
  }
  await clearAccountDeletion(req, { userId: req.user.id });
}

export type ClearAccountDeletionInput = {
  userId: string;
  actorUserId?: string;
  /** Runs in the clear's transaction with the cleared deletion; a throw keeps the deletion pending. */
  recordInTransaction?: (cleared: IUserDeletion) => Promise<void>;
};

/** Cancel core shared by the self-serve wrapper and the admin endpoint; callers own the authorization. */
export async function clearAccountDeletion(
  req: DeletionRequest,
  { userId, actorUserId, recordInTransaction }: ClearAccountDeletionInput
): Promise<void> {
  const cancelled = await withTransaction(async () => {
    // Reads the address and the cleared stamp in the same query that clears the deletion.
    const cleared = await User.findOneAndUpdate(
      // An admin's erasure is not the person's request, so neither they nor support can call it off.
      { _id: userId, deletion: { $ne: null }, 'deletion.purgeStartedAt': null, 'deletion.source': { $ne: 'admin' } },
      { $unset: { deletion: 1 } },
      { projection: { email: 1, deletion: 1 } }
    ).lean<{ email?: string | null; deletion?: IUserDeletion }>();
    if (cleared?.deletion) await recordInTransaction?.(cleared.deletion);
    return cleared;
  });
  if (!cancelled) {
    if (await User.exists({ _id: userId, 'deletion.purgeStartedAt': { $type: 'date' } })) {
      throw new ConflictError('Account deletion has started and can no longer be cancelled.');
    }
    if (await User.exists({ _id: userId, 'deletion.source': 'admin' })) {
      throw new ConflictError("This account is being erased at an administrator's request and cannot be cancelled.");
    }
    throw new NotFoundError('This account is not scheduled for deletion.');
  }
  await logAuthAudit(req, { userId, actorUserId, event: 'account_deletion_cancelled' });

  if (cancelled.email) {
    try {
      await sendAccountDeletionCancelledEmail(cancelled.email);
    } catch (err) {
      req.logger.error(`Failed to send the deletion-cancelled email for user ${userId}: ${String(err)}`);
    }
  }
}
