import { z } from 'zod';
import { updateUserSchema, applyBaseUserUpdates, toUserUpdatePartial } from './update';
import {
  CreditHolderType,
  ICreditTransactionRepository,
  IOrganizationDocument,
  IUserRepository,
  Permission,
  IFriendshipModelAdapter,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, secureParameters } from '@bike4mind/utils';
import { sendFriendRequest } from '../friendshipService/sendFriendRequest';
import { addCredits } from '../creditService/addCredits';
import { subtractCredits } from '../creditService/subtractCredits';
import { MODERATION_POLICY } from './moderationPolicy';

export const adminUpdateUserSchema = updateUserSchema.extend({
  id: z.string(),
  // Admins can directly update email addresses without verification
  email: z.email().optional(),
  role: z.string().optional().nullable(),
  isAdmin: z.boolean().optional(),
  // Admin-only: `tags` was removed from the base self-service schema because it
  // feeds access control. Re-declared here so admins can still manage user tags.
  tags: z.array(z.string()).nullable().optional(),
  organizationId: z.string().optional().nullable(),
  storageLimit: z.number().optional(),
  currentCredits: z.number().optional(),
  isBanned: z.boolean().optional(),
  isModerated: z.boolean().optional(),
  subscribedUntil: z.string().optional().nullable(),
  systemFiles: z.array(z.object({ fileId: z.string(), enabled: z.boolean() })).optional(),
  level: z.enum(['DemoUser', 'PaidUser', 'VIPUser', 'ManagerUser', 'AdminUser']).optional(),
  lastNotebookId: z.string().optional().nullable(),
  userNotes: z.array(z.object({ timestamp: z.string(), note: z.string(), userName: z.string() })).optional(),
  numReferralsAvailable: z.number().optional(),
  disputePending: z.boolean().optional(),
  // Admin control over the per-user moderation escalation state. Routed through
  // `setModerationStatus` (not the generic field spread) so the `isModerated` mirror and
  // `throttledUntil` stay consistent - this is how an admin confirms a `suspend_pending`
  // account, lifts a throttle/suspension back to `active`, or manually throttles.
  moderationStatus: z.enum(['active', 'throttled', 'suspend_pending', 'suspended']).optional(),
  // Human-readable reason for a manual credit adjustment. Not a user-doc field:
  // it is stripped from the doc write and persisted on the audited
  // CreditTransaction (description + metadata.note) instead. See `currentCredits`
  // routing in `adminUpdateUser`.
  creditReason: z.string().max(500).optional(),
  // Signed credit adjustment (e.g. -50 / +100) from the admin credit-adjustment UI.
  // Applied verbatim to the ledger so interim spend between the admin's page load and
  // this write is never refunded (the failure mode of sending a frozen client snapshot
  // as an absolute `currentCredits`). Not a user-doc field: stripped from the doc write
  // and routed to addCredits/subtractCredits. Takes precedence over `currentCredits`.
  creditDelta: z.number().optional(),
});

export type AdminUpdateUserParameters = z.infer<typeof adminUpdateUserSchema>;

export interface AdminUpdateUserAdapters {
  db: {
    users: IUserRepository;
    organizations: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
      update: (organization: Partial<IOrganizationDocument> & { id: string }) => Promise<unknown>;
    };
    friendship: IFriendshipModelAdapter;
    /**
     * Optional: when provided, a `currentCredits` change is routed through the
     * audited credit ledger (addCredits/subtractCredits) instead of a raw
     * balance overwrite, so every admin adjustment leaves a CreditTransaction
     * recording actor, delta, resulting balance, timestamp, and reason. Omit to
     * keep the legacy direct-overwrite behavior (unaudited).
     */
    creditTransactions?: ICreditTransactionRepository;
  };
}

async function sendFriendRequestsToOrgMembers(
  adminId: string,
  organization: IOrganizationDocument,
  db: AdminUpdateUserAdapters['db']
) {
  const memberUserIds = organization.users.map(user => user.userId).filter(userId => userId !== adminId);

  for (const memberId of memberUserIds) {
    try {
      await sendFriendRequest(
        {
          requesterId: adminId,
          recipientId: memberId,
          message: 'Organization admin friend request',
        },
        { db }
      );
    } catch (error) {
      if (error instanceof BadRequestError) {
        console.log(`Error sending friend request to ${memberId}: ${error.message}`);
        return;
      }
      throw error;
    }
  }
}

export async function adminUpdateUser(
  userId: string,
  parameters: AdminUpdateUserParameters,
  { db }: AdminUpdateUserAdapters
) {
  const params = secureParameters(parameters, adminUpdateUserSchema);
  const admin = await db.users.findById(userId);
  if (!admin || !admin.isAdmin) {
    throw new ForbiddenError('Unauthorized');
  }

  const user = await db.users.findByIdWithPassword(params.id);
  if (!user) {
    throw new Error('User not found');
  }
  let lastCreditsPurchasedAt = user.lastCreditsPurchasedAt;
  if ((params.currentCredits ?? 0) > 0 && params.currentCredits !== user.currentCredits) {
    lastCreditsPurchasedAt = new Date();
  }

  // Route a `currentCredits` change through the audited ledger when the adapter
  // is wired. The ledger runs before every write below, so a failure aborts with
  // nothing persisted; its atomic `$inc` is the sole owner of the balance.
  //
  // `moderationStatus`/`creditReason`/`creditDelta` are handled out-of-band (a dedicated
  // repo call, the CreditTransaction record, and the ledger respectively) - pull them out
  // so they never land as stray top-level fields on the user doc.
  const previousBalance = user.currentCredits ?? 0;
  const { moderationStatus, creditReason, creditDelta: signedDelta, ...baseParams } = params;
  // A signed `creditDelta` is applied verbatim (no interim-spend refund). Absolute
  // `currentCredits` falls back to delta-from-fresh-balance.
  const rawDelta =
    signedDelta !== undefined
      ? signedDelta
      : params.currentCredits !== undefined && params.currentCredits !== previousBalance
        ? params.currentCredits - previousBalance
        : 0;
  // Never drive the balance below zero (mirrors the old client-side Math.max(0, ...)
  // clamp, but against the fresh server balance instead of a stale snapshot).
  const creditDelta = Math.max(rawDelta, -previousBalance);
  const auditCreditChange = creditDelta !== 0 && !!db.creditTransactions;

  const builtParams = { ...baseParams, lastCreditsPurchasedAt };
  const builtUser = applyBaseUserUpdates(user, builtParams);
  // Persist ONLY the fields this request changed, never a spread of the read snapshot -
  // that is what let an admin save round-trip (and revert) a concurrent tokenVersion bump
  // or credit deduction. When auditing, drop `currentCredits` so its `$set` cannot clobber
  // the ledger `$inc`; the legacy (no-ledger) path keeps it and overwrites the balance.
  const writeData = toUserUpdatePartial(builtUser, builtParams);
  if (auditCreditChange) {
    delete (writeData as { currentCredits?: number }).currentCredits;
  }

  // Audited credit adjustment: runs BEFORE any persistence (org membership, the
  // user-doc write, the moderation transition) so a ledger failure leaves nothing
  // half-written. Records the actor, delta, resulting balance, and reason as a
  // generic_add / generic_deduct CreditTransaction.
  if (auditCreditChange && db.creditTransactions) {
    const note = creditReason?.trim() || undefined;
    const resultingBalance = previousBalance + creditDelta;
    const metadata: Record<string, unknown> = { actorId: userId, previousBalance, resultingBalance };
    if (note) {
      metadata.note = note;
    }
    const creditAdapters = {
      db: { creditTransactions: db.creditTransactions },
      creditHolderMethods: db.users,
    };
    if (creditDelta > 0) {
      await addCredits(
        {
          ownerId: params.id,
          ownerType: CreditHolderType.User,
          credits: creditDelta,
          type: 'generic_add',
          reason: 'admin_adjustment',
          description: note || 'Admin credit adjustment',
          metadata,
        },
        creditAdapters
      );
    } else {
      await subtractCredits(
        {
          ownerId: params.id,
          ownerType: CreditHolderType.User,
          credits: Math.abs(creditDelta),
          type: 'generic_deduct',
          reason: 'admin_adjustment',
          description: note || 'Admin credit adjustment',
          metadata,
        },
        creditAdapters
      );
    }
  }

  if (!!params.organizationId && user.organizationId !== params.organizationId) {
    if (user.organizationId) {
      const currentOrg = await db.organizations.findById(user.organizationId);
      if (!currentOrg) {
        throw new Error('Organization not found');
      }

      const remainingUsers = currentOrg.users.filter(userDetail => userDetail.userId !== user.id);
      await db.organizations.update({ id: currentOrg.id, users: remainingUsers });
    }

    if (params.organizationId) {
      const newOrg = await db.organizations.findById(params.organizationId);
      if (!newOrg) {
        throw new Error('Organization not found');
      }

      await sendFriendRequestsToOrgMembers(userId, newOrg, db);

      const updatedUsers = [...newOrg.users, { userId: user.id, permissions: [Permission.read] }];
      await db.organizations.update({ id: newOrg.id, users: updatedUsers });
    }
  }

  await db.users.update(writeData);

  // Apply the moderation escalation transition last so it authoritatively sets
  // `moderation.status`, `throttledUntil`, and the `isModerated` mirror.
  if (moderationStatus) {
    await db.users.setModerationStatus(params.id, moderationStatus, {
      throttledUntil:
        moderationStatus === 'throttled' ? new Date(Date.now() + MODERATION_POLICY.throttleDurationMs) : null,
    });
  }

  const finalUser = await db.users.findById(params.id);

  return finalUser;
}
