import {
  IInviteRepository,
  IOrgDomainClaimRepository,
  ISpaceDocument,
  ISpaceRepository,
  IUserDocument,
  InviteType,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const adminRemoveSchema = z.object({ spaceId: z.string().min(1) });

type AdminRemoveParameters = z.infer<typeof adminRemoveSchema>;

interface AdminRemoveAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'findLiveById' | 'softDelete'>;
    invites: Pick<IInviteRepository, 'revokeAllForDocument'>;
    orgDomainClaims: Pick<IOrgDomainClaimRepository, 'deleteBySpace'>;
  };
}

/**
 * Platform admin delete of a Space the caller need not belong to. The route checks the admin; this does not.
 * Returns the deleted Space for the audit entry and the owner notice. Caller wraps in withTransaction.
 */
export async function adminRemove(
  _admin: IUserDocument,
  parameters: AdminRemoveParameters,
  adapters: AdminRemoveAdapters
): Promise<ISpaceDocument> {
  const { spaceId } = secureParameters(parameters, adminRemoveSchema);
  const { db } = adapters;

  const space = await db.spaces.findLiveById(spaceId);
  if (!space) throw new NotFoundError('Space not found');

  if (!(await db.spaces.softDelete(spaceId, space.ownerUserId))) throw new NotFoundError('Space not found');
  await db.invites.revokeAllForDocument(spaceId, InviteType.Space);
  await db.orgDomainClaims.deleteBySpace(spaceId);
  return space;
}
