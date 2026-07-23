import { z } from 'zod';
import { updateUserSchema, applyBaseUserUpdates } from './update';
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

const adminUpdateUserSchema = updateUserSchema.extend({
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
});

export type AdminUpdateUserParameters = z.infer<typeof adminUpdateUserSchema>;

export interface AdminUpdateUserAdapters {
  db: {
    users: IUserRepository;
    organizations: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
      update: (organization: IOrganizationDocument) => Promise<unknown>;
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

  // Route a credit change through the audited ledger when the adapter is wired.
  // The atomic increment (below, after the base doc write) then owns the balance,
  // so `currentCredits` must NOT also be spread onto the doc - a full-doc write
  // carrying the stale balance would clobber the increment.
  const previousBalance = user.currentCredits ?? 0;
  const creditDelta =
    params.currentCredits !== undefined && params.currentCredits !== previousBalance
      ? params.currentCredits - previousBalance
      : 0;
  const auditCreditChange = creditDelta !== 0 && !!db.creditTransactions;

  // `moderationStatus`/`creditReason` are handled out-of-band (a dedicated repo
  // call and the credit ledger, respectively) - pull them out so they never land
  // as stray top-level fields on the user doc.
  const { moderationStatus, creditReason, ...baseParams } = params;
  // When auditing the credit change, drop `currentCredits` from the doc write so
  // the atomic increment below is the sole balance mutation.
  if (auditCreditChange) {
    delete baseParams.currentCredits;
  }
  const updatedUser = applyBaseUserUpdates(user, { ...baseParams, lastCreditsPurchasedAt });

  if (!!params.organizationId && user.organizationId !== params.organizationId) {
    if (user.organizationId) {
      const currentOrg = await db.organizations.findById(user.organizationId);
      if (!currentOrg) {
        throw new Error('Organization not found');
      }

      currentOrg.users = currentOrg.users.filter(userDetail => userDetail.userId !== user.id);
      await db.organizations.update(currentOrg);
    }

    if (params.organizationId) {
      const newOrg = await db.organizations.findById(params.organizationId);
      if (!newOrg) {
        throw new Error('Organization not found');
      }

      await sendFriendRequestsToOrgMembers(userId, newOrg, db);

      newOrg.users.push({ userId: user.id, permissions: [Permission.read] });
      await db.organizations.update(newOrg);
    }
  }

  await db.users.update(updatedUser);

  // Apply the moderation escalation transition last so it authoritatively sets
  // `moderation.status`, `throttledUntil`, and the `isModerated` mirror.
  if (moderationStatus) {
    await db.users.setModerationStatus(params.id, moderationStatus, {
      throttledUntil:
        moderationStatus === 'throttled' ? new Date(Date.now() + MODERATION_POLICY.throttleDurationMs) : null,
    });
  }

  // Audited credit adjustment: runs AFTER the base doc write so the atomic
  // increment is the final word on the balance. Records who (actorId = the
  // acting admin), the delta (the transaction `credits`), the resulting
  // balance, and the reason, as a generic_add / generic_deduct CreditTransaction.
  if (auditCreditChange && db.creditTransactions) {
    const note = creditReason?.trim() || undefined;
    const resultingBalance = params.currentCredits as number;
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

  const finalUser = await db.users.findById(params.id);

  return finalUser;
}
