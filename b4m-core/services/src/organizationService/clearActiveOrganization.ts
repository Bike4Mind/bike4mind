import { z } from 'zod';
import { IUserDocument, IUserRepository, secureParameters, ForbiddenError } from '@bike4mind/common';

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
 * Cost of clearing is wider than balance: the same pointer also gates org-scoped reads and writes -
 * org-tier artifact visibility, publishing to org scope, the data-lake access context, and
 * knowledgeBaseSearch all key off it - so clearing drops the caller's org-scoped access too, not
 * just their spend. Still the right trade against being unable to spend at all, but callers must
 * not treat it as a balance-only reset (e.g. no UI affordance built on the narrower promise).
 *
 * Clears the pointer ONLY - no membership, group, or ownership change - so it is safe for an owner
 * or a plain member, and idempotent (clearing an already-null pointer is a harmless no-op write).
 * There is no automatic re-set path: restoring the pointer, and separating the field's two
 * overloaded meanings, is #1172's active-org work.
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
