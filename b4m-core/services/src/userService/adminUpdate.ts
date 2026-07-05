import { z } from 'zod';
import { updateUserSchema, applyBaseUserUpdates } from './update';
import { IOrganizationDocument, IUserRepository, Permission, IFriendshipModelAdapter } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, secureParameters } from '@bike4mind/utils';
import { sendFriendRequest } from '../friendshipService/sendFriendRequest';
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

  // `moderationStatus` is applied via a dedicated repo call below, not the generic field
  // spread - pull it out so it never lands as a stray top-level field on the user doc.
  const { moderationStatus, ...baseParams } = params;
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

  const finalUser = await db.users.findById(params.id);

  return finalUser;
}
