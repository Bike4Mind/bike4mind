import { IOrganizationDocument, IOrganizationRepository, IUserDocument, WithId } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
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
interface DeleteAdapters {
  db: {
    organizations: IOrganizationRepository;
  };
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

  // Deleting an organization is owner-scoped. `get` authorizes via findAccessibleById, which any
  // member holding read satisfies, so it is not by itself a sufficient gate on an org-wide
  // destructive operation. Deliberately narrower than assertCanManageOrgGroups, which also admits
  // appointed org admins: an appointed admin manages groups, not the organization's existence.
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

  // Delete the organization
  await adapters.db.organizations.delete(id);
}
