import {
  ForbiddenError,
  IOrganizationRepository,
  ISpaceDocument,
  ISpaceRepository,
  IUserDocument,
  MAX_OWNED_SPACES,
  SPACE_CREATION_REQUIRES_PAID_STANDING_CODE,
  SPACE_DESCRIPTION_MAX,
  SPACE_LIMIT_REACHED_CODE,
  SPACE_NAME_MAX,
  canAdministerOrganization,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string().trim().min(1).max(SPACE_NAME_MAX),
  description: z.string().max(SPACE_DESCRIPTION_MAX).nullish(),
  parentOrganizationId: z.string().min(1).nullish(),
});

type CreateParameters = z.infer<typeof createSchema>;

interface CreateAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'create' | 'countOwned'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
  };
  gate: { canCreate: boolean };
}

/**
 * Creates a Space owned by the caller. The owner is `ownerUserId`, not a member row.
 * The owned-Space cap is not atomic: a race can leave one Space over it.
 */
export async function create(
  user: IUserDocument,
  parameters: CreateParameters,
  adapters: CreateAdapters
): Promise<ISpaceDocument> {
  const { name, description, parentOrganizationId } = secureParameters(parameters, createSchema);
  const { db, gate } = adapters;

  if (!gate.canCreate) {
    throw new ForbiddenError('Creating a Space requires a paid plan or a credit purchase', {
      code: SPACE_CREATION_REQUIRES_PAID_STANDING_CODE,
    });
  }
  if ((await db.spaces.countOwned(user.id)) >= MAX_OWNED_SPACES) {
    throw new ForbiddenError(`You can own at most ${MAX_OWNED_SPACES} Spaces`, { code: SPACE_LIMIT_REACHED_CODE });
  }

  if (parentOrganizationId) {
    const organization = await db.organizations.findById(parentOrganizationId);
    if (!organization || !canAdministerOrganization(user, organization)) {
      throw new NotFoundError('Organization not found');
    }
  }

  return db.spaces.create({
    name,
    description: description ?? null,
    ownerUserId: user.id,
    members: [],
    removedUserIds: [],
    parentOrganizationId: parentOrganizationId ?? null,
  });
}
