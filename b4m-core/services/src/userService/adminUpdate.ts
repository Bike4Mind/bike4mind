import { z } from 'zod';
import {
  updateUserSchema,
  applyBaseUserUpdates,
  toUserUpdatePartial,
  validateUsernameChange,
  writeUserUpdate,
  EMAIL_IN_USE_MESSAGE,
} from './update';
import {
  ConflictError,
  MAX_STORAGE_LIMIT_MB,
  resolveUserStorageLimit,
  CreditHolderType,
  ICreditTransactionRepository,
  IOrganizationDocument,
  IUserRepository,
  Permission,
  IFriendshipModelAdapter,
  IUserApiKeyRepository,
  IRealtimeConnectionRepository,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, secureParameters } from '@bike4mind/utils';
import { sendFriendRequest } from '../friendshipService/sendFriendRequest';
import { addCreditsWithLedgerRow } from '../creditService/addCredits';
import { subtractCreditsWithLedgerRow } from '../creditService/subtractCredits';
import { MODERATION_POLICY } from './moderationPolicy';
import { entersBlockedState } from './accountState';
import { endRealtimeConnections } from '../authSessionService/endRealtimeConnections';

const MAX_CREDIT_VALUE = 1_000_000_000;

export const adminUpdateUserSchema = updateUserSchema.extend({
  id: z.string(),
  // Admins can directly update email addresses without verification
  email: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  role: z.string().optional().nullable(),
  isAdmin: z.boolean().optional(),
  // Admin-only: `tags` was removed from the base self-service schema because it
  // feeds access control. Re-declared here so admins can still manage user tags.
  tags: z.array(z.string()).nullable().optional(),
  organizationId: z.string().optional().nullable(),
  storageLimit: z.number().min(0).max(MAX_STORAGE_LIMIT_MB).optional(),
  storageLimitOverride: z.number().min(0).max(MAX_STORAGE_LIMIT_MB).nullable().optional(),
  currentCredits: z.number().int().min(0).max(MAX_CREDIT_VALUE).optional(),
  isBanned: z.boolean().optional(),
  isModerated: z.boolean().optional(),
  subscribedUntil: z.string().optional().nullable(),
  systemFiles: z.array(z.object({ fileId: z.string(), enabled: z.boolean() })).optional(),
  level: z.enum(['DemoUser', 'PaidUser', 'VIPUser', 'ManagerUser', 'AdminUser']).optional(),
  lastNotebookId: z.string().optional().nullable(),
  numReferralsAvailable: z.number().optional(),
  disputePending: z.boolean().optional(),
  // Admin control over the per-user moderation escalation state. Routed through
  // `setModerationStatus` (not the generic field spread) so `throttledUntil` stays consistent -
  // this is how an admin confirms a `suspend_pending`
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
  creditDelta: z.number().int().min(-MAX_CREDIT_VALUE).max(MAX_CREDIT_VALUE).optional(),
  // Why the admin role is being granted or revoked. Not a user-doc field: the route records it on
  // the audit entry, and it is stripped from the doc write here.
  roleChangeReason: z.string().max(500).optional(),
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
    // Required: a ban, dispute or suspension must deactivate the user's API keys.
    userApiKeys: Pick<IUserApiKeyRepository, 'deactivateAllByUserId'>;
    // Required: a ban, dispute or suspension must also end the user's realtime connections.
    realtimeConnections: Pick<IRealtimeConnectionRepository, 'endConnections'>;
    // Required: every admin balance change goes through the ledger (addCredits/subtractCredits),
    // so no admin adjustment can land without a CreditTransaction row.
    creditTransactions: ICreditTransactionRepository;
  };
}

/** The balance change an admin update applied; signed, after the non-negative floor. */
export type AdminCreditAdjustment = {
  credits: number;
  previousBalance: number;
  resultingBalance: number;
  note?: string;
  /** The CreditTransaction row the adjustment wrote; the audit entry links to it. */
  creditTransactionId?: string;
};

export type AdminUpdateUserResult = {
  user: Awaited<ReturnType<IUserRepository['findById']>>;
  creditAdjustment: AdminCreditAdjustment | null;
};

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
): Promise<AdminUpdateUserResult> {
  const params = secureParameters(parameters, adminUpdateUserSchema);
  const admin = await db.users.findById(userId);
  if (!admin || !admin.isAdmin) {
    throw new ForbiddenError('Unauthorized');
  }

  const user = await db.users.findByIdWithPassword(params.id);
  if (!user) {
    throw new Error('User not found');
  }
  await validateUsernameChange(user, params, db.users, { allowReservedUsername: true });
  if (params.email !== undefined && params.email !== user.email) {
    if (await db.users.existsOtherUserWithEmail(params.email, user.id)) {
      throw new ConflictError(EMAIL_IN_USE_MESSAGE);
    }
  }

  // Route a `currentCredits` change through the audited ledger; its atomic `$inc` is the
  // sole owner of the balance. The ledger runs
  // before every other write, but this function is not atomic on its own (callers
  // wrap it in a transaction):
  // - a ledger failure can still leave a CreditTransaction row for credits never
  //   applied (addCredits/subtractCredits write the row before the `$inc`);
  // - a failure after the ledger leaves the balance committed and skips the org
  //   membership move, the doc write, the moderation transition, and the API-key
  //   deactivation.
  //
  // `moderationStatus`/`creditReason`/`creditDelta`/`roleChangeReason` are handled out-of-band (a
  // dedicated repo call, the CreditTransaction record, the ledger, and the route's audit entry) - pull them out
  // so they never land as stray top-level fields on the user doc.
  const previousBalance = user.currentCredits ?? 0;
  const { moderationStatus, creditReason, creditDelta: signedDelta, roleChangeReason, ...baseParams } = params;
  // Which moderation statuses block (only `suspended`) lives in accountState.ts, shared with the
  // Stripe dispute path and the client use-time gate.
  const enteringBlockedState = entersBlockedState(user, {
    isBanned: params.isBanned ?? user.isBanned,
    disputePending: params.disputePending ?? user.disputePending,
    moderation: { status: moderationStatus ?? user.moderation?.status },
  });
  // A signed `creditDelta` is applied verbatim (no interim-spend refund). Absolute
  // `currentCredits` falls back to delta-from-snapshot.
  const rawDelta =
    signedDelta !== undefined
      ? signedDelta
      : params.currentCredits !== undefined && params.currentCredits !== previousBalance
        ? params.currentCredits - previousBalance
        : 0;
  // A deduction never drives the balance further down than zero, and is rejected outright when
  // there is nothing to deduct so the caller does not see a silent success.
  if (rawDelta < 0 && previousBalance <= 0) {
    throw new BadRequestError('Balance is already at or below zero; nothing to deduct');
  }
  const creditDelta = rawDelta < 0 ? Math.max(rawDelta, -previousBalance) : rawDelta;
  const note = creditReason?.trim() || undefined;

  // Stamp a purchase timestamp only for a net grant: a deduction is not a purchase, and carrying
  // the field on every other admin save would $set the read snapshot back over a concurrent
  // purchase stamp (addCredits only stamps for type === 'purchase', so an admin grant needs this).
  const requestedOverride =
    params.storageLimitOverride !== undefined ? params.storageLimitOverride : params.storageLimit;
  const storageParams =
    requestedOverride !== undefined
      ? {
          storageLimitOverride: requestedOverride,
          storageLimit: resolveUserStorageLimit({
            storageLimitOverride: requestedOverride,
            planStorageLimit: user.planStorageLimit,
          }).limitMb,
        }
      : {};
  const builtParams = {
    ...baseParams,
    ...storageParams,
    ...(creditDelta > 0 ? { lastCreditsPurchasedAt: new Date() } : {}),
  };
  const builtUser = applyBaseUserUpdates(user, builtParams);
  // Persist ONLY the fields this request changed, never a spread of the read snapshot -
  // that is what let an admin save round-trip (and revert) a concurrent tokenVersion bump
  // or credit deduction. `currentCredits` is always dropped so its `$set` can never overwrite
  // the balance outside the ledger `$inc`.
  const writeData = toUserUpdatePartial(builtUser, builtParams);
  delete (writeData as { currentCredits?: number }).currentCredits;

  // Validate the org move before the ledger so an unknown org cannot leave a
  // committed balance behind; the membership writes themselves stay after it.
  let currentOrg: IOrganizationDocument | null = null;
  let newOrg: IOrganizationDocument | null = null;
  if (params.organizationId && user.organizationId !== params.organizationId) {
    if (user.organizationId) {
      currentOrg = await db.organizations.findById(user.organizationId);
      if (!currentOrg) {
        throw new Error('Organization not found');
      }
    }
    newOrg = await db.organizations.findById(params.organizationId);
    if (!newOrg) {
      throw new Error('Organization not found');
    }
  }

  // Records the actor, delta, resulting balance, and reason as a generic_add /
  // generic_deduct CreditTransaction (ordering and failure modes: see above).
  let creditAdjustment: AdminCreditAdjustment | null = null;
  if (creditDelta !== 0) {
    // Predicted from the read snapshot; an absolute set is applied as a delta, so concurrent
    // spend before the atomic $inc makes the committed balance differ from this value.
    const resultingBalance = previousBalance + creditDelta;
    const metadata: Record<string, unknown> = { actorId: userId, previousBalance, resultingBalance };
    if (note) {
      metadata.note = note;
    }
    const creditAdapters = {
      db: { creditTransactions: db.creditTransactions },
      creditHolderMethods: db.users,
    };
    const { creditTransactionId } =
      creditDelta > 0
        ? await addCreditsWithLedgerRow(
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
          )
        : await subtractCreditsWithLedgerRow(
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
    creditAdjustment = { credits: creditDelta, previousBalance, resultingBalance, note, creditTransactionId };
  }

  if (currentOrg) {
    const remainingUsers = currentOrg.users.filter(userDetail => userDetail.userId !== user.id);
    await db.organizations.update({ id: currentOrg.id, users: remainingUsers });
  }

  if (newOrg) {
    await sendFriendRequestsToOrgMembers(userId, newOrg, db);

    // The owner holds a seat without a row, and a target already in users[] keeps one row (read
    // merged in) rather than gaining a duplicate.
    if (String(newOrg.userId) !== user.id) {
      const existing = newOrg.users.find(userDetail => userDetail.userId === user.id);
      const permissions = [...new Set([...(existing?.permissions ?? []), Permission.read])];
      const updatedUsers = [
        ...newOrg.users.filter(userDetail => userDetail.userId !== user.id),
        { userId: user.id, permissions },
      ];
      await db.organizations.update({ id: newOrg.id, users: updatedUsers });
    }
  }

  await writeUserUpdate(db.users, writeData);

  // Apply the moderation escalation transition last so it authoritatively sets
  // `moderation.status` and `throttledUntil`. It leaves `isModerated` as written above.
  if (moderationStatus) {
    await db.users.setModerationStatus(params.id, moderationStatus, {
      throttledUntil:
        moderationStatus === 'throttled' ? new Date(Date.now() + MODERATION_POLICY.throttleDurationMs) : null,
    });
  }

  // Leaving the state later does not reactivate keys; the user mints new ones.
  if (enteringBlockedState) {
    await db.userApiKeys.deactivateAllByUserId(params.id);
    await endRealtimeConnections({ userId: params.id }, { db });
  }

  const finalUser = await db.users.findById(params.id);

  return { user: finalUser, creditAdjustment };
}
