import { ISpaceDocument, ISpaceRepository, emailDomainOf } from '@bike4mind/common';

interface RecheckDomainMembersAdapters {
  db: { spaces: Pick<ISpaceRepository, 'listDomainJoinedForUser' | 'removeMember'> };
  isDomainJoinable: (space: ISpaceDocument, email: string) => Promise<boolean>;
}

/**
 * After an email change, drops the user from every Space they joined by domain whose rule the new
 * address no longer meets. A move within the same domain keeps the member, since a released claim
 * leaves existing domain joiners in place. Invite and link members are untouched, and the removal never blocks a
 * rejoin. Writes go only through the DB and a pull is idempotent, so a transaction retry is safe.
 */
export async function recheckDomainMembers(
  userId: string,
  emails: { oldEmail: string | null; newEmail: string },
  adapters: RecheckDomainMembersAdapters
): Promise<void> {
  const { db, isDomainJoinable } = adapters;
  const { oldEmail, newEmail } = emails;
  const oldDomain = oldEmail === null ? null : emailDomainOf(oldEmail);
  if (oldDomain && oldDomain === emailDomainOf(newEmail)) return;
  for (const space of await db.spaces.listDomainJoinedForUser(userId)) {
    if (await isDomainJoinable(space, newEmail)) continue;
    await db.spaces.removeMember(space.id, userId, { block: false });
  }
}
