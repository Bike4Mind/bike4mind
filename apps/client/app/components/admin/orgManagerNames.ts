import { type AdministrableOrg, canAdministerOrganization, type IUserDetails } from '@bike4mind/common';

/**
 * Display names of the org's managers - the people its write gate (`canAdministerOrganization`)
 * admits besides the owner - for the admin org profile. Names come from `userDetails[]`, because
 * the `users[].user` virtual is never populated on the admin org list; an id with no details row
 * falls back to the raw id so the manager is still listed.
 */
export function orgManagerNames(
  org: AdministrableOrg & { userDetails?: ReadonlyArray<Pick<IUserDetails, 'id' | 'name' | 'email'>> | null }
): string[] {
  const candidateIds = new Set([...(org.adminUserIds ?? []), ...(org.managerId ? [org.managerId] : [])]);
  return [...candidateIds]
    .filter(id => id !== org.userId && canAdministerOrganization({ id }, org))
    .map(id => {
      const details = org.userDetails?.find(detail => String(detail.id) === id);
      return details?.name || details?.email || id;
    });
}
