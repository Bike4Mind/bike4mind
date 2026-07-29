import type { DataLakeMembershipScope, IDataLakeDocument, IUserRepository } from '@bike4mind/common';

export interface LakeMembershipScopeAdapters {
  db: {
    users: Pick<IUserRepository, 'findById'>;
  };
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

/** The lake fields the membership scope is derived from - always the persisted document. */
type ScopeSourceLake = Pick<IDataLakeDocument, 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>;

/**
 * Builds the scope every whole-lake file query runs on: the lake's meta-tag plus the creator
 * identity its `fileTagPrefix` arm is anchored to. The creator's group ids come from their user
 * record, so a file shared into the lake through one of the creator's groups counts as a member
 * the same way the browse counts it.
 *
 * A missing or unreadable creator is not fatal - the scope still matches by meta-tag - but it is
 * logged, because the symptom of silently dropping the group arm is a group-shared prefix-only
 * file that quietly survives archiving and permanent deletion. That is the exact bug this scope
 * exists to fix, and an empty result set looks identical to a lake that simply has no such files.
 */
export const resolveLakeMembershipScope = async (
  lake: ScopeSourceLake,
  { db, logger }: LakeMembershipScopeAdapters
): Promise<DataLakeMembershipScope> => {
  const base: DataLakeMembershipScope = {
    datalakeTag: lake.datalakeTag,
    fileTagPrefix: lake.fileTagPrefix,
    creatorUserId: lake.createdByUserId,
  };

  const degrade = (why: string, err?: unknown) => {
    logger?.warn(`[dataLakes] ${why} for ${lake.datalakeTag}; group-shared prefix-tagged members will not match`, err);
    return base;
  };

  if (!lake.createdByUserId) return degrade('no createdByUserId');

  try {
    const creator = await db.users.findById(lake.createdByUserId);
    if (!creator) return degrade('creator record not found');
    return { ...base, creatorGroupIds: creator.groups ?? [] };
  } catch (err) {
    return degrade('could not read the creator', err);
  }
};
