import type { DataLakeTeardownScope, IDataLakeDocument, IDataLakeRepository } from '@bike4mind/common';
import { resolveEffectiveOwnerIds, type LakeGrant } from './manageRule';
import { lakeMembershipScope, registryMembershipScope } from './lakeMembershipScope';
import { loadPrefixArmCandidateLakes } from './prefixArmMembership';
import { registryCandidateLakes } from './registryCandidateLakes';

/**
 * Which of a lake's members a whole-lake teardown (deleteDataLake, cleanupDeletedDataLake) may
 * destroy: the effective owners' files that no other lake holds. Other lakes are matched under
 * the full membership rule, so a file held by a second lake only through that lake's prefix arm
 * is kept too. Only lakes an owner created can reach an owner's file through a prefix arm (the
 * arm is anchored to the lake's creator), plus the registry lakes, whose prefix arm is open.
 *
 * Lakes of every status count: a deleted lake can still be restored with its files.
 */
export const resolveLakeTeardownScope = async (
  lake: Pick<IDataLakeDocument, 'id' | 'createdByUserId'>,
  grants: readonly LakeGrant[],
  { db }: { db: { dataLakes: Pick<IDataLakeRepository, 'find'> } }
): Promise<DataLakeTeardownScope> => {
  const ownerUserIds = resolveEffectiveOwnerIds(lake, grants);
  const ownersLakes = await loadPrefixArmCandidateLakes(ownerUserIds, { db });
  const otherLakes = [
    ...ownersLakes.filter(other => other.id !== lake.id && other.fileTagPrefix).map(lakeMembershipScope),
    ...registryCandidateLakes()
      .filter(registry => registry.fileTagPrefix)
      .map(registryMembershipScope),
  ];
  return { ownerUserIds, otherLakes };
};
