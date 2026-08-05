import { z } from 'zod';
import { secureParameters, ForbiddenError } from '@bike4mind/utils';
import { IUserDocument, IUserRepository } from '@bike4mind/common';

const clearActiveOrganizationSchema = z.object({
  userId: z.string().min(1),
});

type ClearActiveOrganizationParameters = z.infer<typeof clearActiveOrganizationSchema>;

interface ClearActiveOrganizationAdapters {
  db: {
    users: Pick<IUserRepository, 'update'>;
  };
}

/**
 * Clears a user's active-organization pointer (`user.organizationId`), returning them to their
 * personal scope and balance. This is the self-service escape for #1428: `user.organizationId` is
 * both the capability-resolution scope AND the billing selector, so an org's billing owner who ends
 * up pointed at an unfunded org gets "insufficient credits" with no way out - `leave` refuses the
 * owner and only ever removes a member row, never the owner's pointer.
 *
 * Clears the pointer ONLY - no membership, group, or ownership change - so it is safe for an owner
 * or a plain member, and idempotent (clearing an already-null pointer is a harmless no-op write).
 * It does NOT separate the field's two overloaded meanings; that is #1172's active-org work.
 *
 * authz: the user themselves, or a platform admin clearing another user's pointer.
 */
export const clearActiveOrganization = async (
  actingUser: IUserDocument,
  parameters: ClearActiveOrganizationParameters,
  adapters: ClearActiveOrganizationAdapters
): Promise<void> => {
  const { userId } = secureParameters(parameters, clearActiveOrganizationSchema);

  if (actingUser.id !== userId && !actingUser.isAdmin) {
    throw new ForbiddenError("Not authorized to clear this user's active organization");
  }

  await adapters.db.users.update({ id: userId, organizationId: null });
};
