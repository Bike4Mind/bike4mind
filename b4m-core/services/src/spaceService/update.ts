import {
  ForbiddenError,
  IOrganizationRepository,
  ISpaceDocument,
  ISpaceRepository,
  IUserDocument,
  SPACE_DESCRIPTION_MAX,
  SPACE_NAME_MAX,
  canAdministerOrganization,
  isSpaceManager,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const updateSchema = z.object({
  spaceId: z.string().min(1),
  name: z.string().trim().min(1).max(SPACE_NAME_MAX).optional(),
  description: z.string().max(SPACE_DESCRIPTION_MAX).nullable().optional(),
  parentOrganizationId: z.string().min(1).nullable().optional(),
});

type UpdateParameters = z.infer<typeof updateSchema>;

interface UpdateAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'findLiveById' | 'updateDetails'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
}

/** Owner and admins edit details. A parent change needs administrator rights on the new parent; `null` clears it. */
export async function update(
  user: IUserDocument,
  parameters: UpdateParameters,
  adapters: UpdateAdapters
): Promise<ISpaceDocument> {
  const { spaceId, ...details } = secureParameters(parameters, updateSchema);
  const { db } = adapters;

  const space = await loadForMember(db.spaces, user.id, spaceId);
  if (!isSpaceManager(user.id, space)) throw new ForbiddenError('Only a Space admin can edit it');

  if (details.parentOrganizationId) {
    const organization = await db.organizations.findById(details.parentOrganizationId);
    if (!organization || !canAdministerOrganization(user, organization)) {
      throw new NotFoundError('Organization not found');
    }
  }

  const updated = await db.spaces.updateDetails(spaceId, details);
  if (!updated) throw new NotFoundError('Space not found');
  return updated;
}
