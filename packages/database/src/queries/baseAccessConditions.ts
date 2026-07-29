/**
 * Base access arms: the file genuinely belongs to, or is shared with, this user.
 *
 * Used as the top-level $or arms of the file search AND to scope a data lake's
 * user-chosen `fileTagPrefix` match - in the read path via buildOwnershipConditions and in the
 * whole-lake writes via buildDataLakeMembershipFilter. Lives in its own module so both can
 * import it without a cycle: a new access arm must reach every one of them, or a read and a
 * whole-lake write will disagree about who is a lake member.
 */
export function buildBaseAccessConditions(userId: string, groupIds: string[] = []): object[] {
  const baseAccess: object[] = [
    { userId },
    {
      users: {
        $elemMatch: {
          userId,
          permissions: { $in: ['read', 'write'] },
        },
      },
    },
  ];

  if (groupIds.length > 0) {
    baseAccess.push({
      groups: {
        $elemMatch: {
          groupId: { $in: groupIds },
          permissions: { $in: ['read', 'write'] },
        },
      },
    });
  }

  return baseAccess;
}
