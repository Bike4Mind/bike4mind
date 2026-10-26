import {
  IGroupRepository,
  IOrganizationDocument,
  IOrganizationRepository,
  IUserDocument,
  IUserRepository,
  WithId,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import {
  lapseDissolvedOrganizationLakeAccess,
  type LakeAccessLapseTrigger,
  type LapseDepartedMemberLakeAccessAdapters,
} from '../dataLakeService';
import { get } from './get';

export const deleteSchema = z.object({
  /**
   * Organization ID
   */
  id: z.string().min(1),
});

export type DeleteParameters = z.infer<typeof deleteSchema>;

export type DeleteValidationFn = (
  organization: WithId<IOrganizationDocument>
) => Promise<{ canDelete: boolean; reason?: string }>;

/**
 * Adapters interface for the deleteOrganization operation
 */
interface DeleteAdapters extends LapseDepartedMemberLakeAccessAdapters {
  db: LapseDepartedMemberLakeAccessAdapters['db'] & {
    organizations: IOrganizationRepository;
    groups: Pick<IGroupRepository, 'findByOrganization' | 'delete'>;
    users: Pick<IUserRepository, 'removeGroupsFromAllUsers' | 'clearOrganizationPointer'>;
  };
  /** API-key principal for the lake audit rows; see `PurgeOrgMembershipAdapters.auditPrincipal`. */
  auditPrincipal?: LakeAccessLapseTrigger['auditPrincipal'];
  /**
   * Optional validation service to determine if organization can be deleted
   */
  validation?: {
    canDeleteOrganization: DeleteValidationFn;
  };
}

/**
 * Delete an organization
 * @param user - The user making the request
 * @param params - The parameters for the operation
 * @param adapters - The adapters for the operation
 * @throws {Error} If organization cannot be deleted based on validation, includes reason if provided
 *
 * Caller MUST wrap this in withTransaction (see the route): the member purge, the group
 * soft-deletes, the members' lake-grant lapse, the members' organizationId reset, and the org delete
 * have to commit together, or a partial failure leaves either dangling group or lake access or an org
 * that never actually deletes.
 */
export async function deleteOrganization(
  user: IUserDocument,
  params: DeleteParameters,
  adapters: DeleteAdapters
): Promise<void> {
  // Validate parameters
  const validatedParams = secureParameters(params, deleteSchema);
  const { id } = validatedParams;

  // Get organization first to validate
  const organization = await get(user, { id }, adapters);

  // Deleting an organization is owner-scoped. `get` admits readers and appointed managers, so it is
  // not by itself a sufficient gate on an org-wide destructive operation. This is narrower than
  // assertCanManageOrgGroups: appointed org admins manage groups, not the organization's existence.
  // A member who wants out uses organizationService.leave instead.
  if (!user.isAdmin && organization.userId !== user.id) {
    throw new ForbiddenError('Not authorized to delete this organization');
  }

  // Run validation if provided
  if (adapters.validation?.canDeleteOrganization) {
    const result = await adapters.validation.canDeleteOrganization(organization);
    if (!result.canDelete) {
      throw new BadRequestError(`Organization deletion validation failed${result.reason ? `: ${result.reason}` : ''}`);
    }
  }

  // Purge this org's group footprint BEFORE soft-deleting the org (org-groups #1172/#1219).
  // Members first, then the group instances - user.groups[] is the access-bearing artifact: the
  // sharing layer's `groups.$elemMatch.groupId $in user.groups` match still succeeds against a
  // soft-deleted group's id, so purging membership after the group delete (or not at all) would
  // leave live access to a group whose organization no longer exists. Mirrors the revoke order in
  // setOrganizationGroupTypes for the same reason.
  // includeDeleted: org deletion is the last chance to reconcile membership, so purge EVERY group
  // the org ever owned - including already-soft-deleted ones whose ids can still linger in
  // user.groups from a lost prior revoke. Once the org row is gone there is nothing left to join
  // against, and ability.ts keeps matching a document's groups[] against user.groups (#1230).
  const orgGroups = await adapters.db.groups.findByOrganization(id, { includeDeleted: true });
  if (orgGroups.length > 0) {
    const groupIds = orgGroups.map(group => group.id);
    await adapters.db.users.removeGroupsFromAllUsers(groupIds);
    // Soft-delete each group via the inherited `delete` (softDeletePlugin). It now joins the
    // caller's transaction through transactionAsyncLocalStorage (#1228), so no bulk workaround.
    // delete() is a no-op on an already-soft-deleted row, so passing stale ids here is harmless.
    for (const groupId of groupIds) {
      await adapters.db.groups.delete(groupId);
    }
  }

  // Grants carry no membership qualifier, so members' grants on this org's lakes would outlive the
  // org. Same lapse-and-hand-off as a single departure (purgeOrgMembership.ts), for everyone at once.
  const memberUserIds = [
    ...(organization.users ?? []).map(member => String(member.userId)),
    ...(organization.adminUserIds ?? []).map(String),
  ];
  await lapseDissolvedOrganizationLakeAccess(
    memberUserIds,
    { id: organization.id, userId: String(organization.userId) },
    { userId: user.id, auditPrincipal: adapters.auditPrincipal },
    adapters
  );

  // Members would otherwise keep an active-org pointer to a deleted org and stay org-scoped.
  await adapters.db.users.clearOrganizationPointer(id);

  // The inherited `delete` (softDeletePlugin) now joins the caller's transaction via ALS (#1228),
  // so this soft-delete rolls back with the surrounding writes instead of committing immediately.
  await adapters.db.organizations.delete(id);
}
