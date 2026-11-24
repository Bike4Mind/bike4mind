import type { AssignableOrgRole } from '@bike4mind/common';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminHomeOrganization } from '@client/pages/api/admin/users/[userId]/home-organization';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { adminUpdateErrorMessage } from './useAdminUserUpdate';

export type OrgMemberRoleChoice = AssignableOrgRole;

/**
 * The raw home-org pointer, which the profile's user record serves as null once the user left that org or
 * it was deleted. Keyed under ['admin', 'users', userId] so the membership writes below refresh it.
 */
export const useAdminHomeOrg = (userId: string | null) =>
  useQuery({
    queryKey: ['admin', 'users', userId, 'home-organization'],
    queryFn: async () =>
      (await api.get<AdminHomeOrganization>(`/api/admin/users/${encodeURIComponent(userId ?? '')}/home-organization`))
        .data,
    enabled: userId !== null,
  });

/**
 * Audited org membership writes for one user (pages/api/admin/organizations/[id]/members, and
 * pages/api/admin/users/[userId]/home-organization for the home-org pointer). Failures
 * toast here and rethrow an Error with the same message, so an ActionDialog stays open and an undo
 * reports the friendly text instead of the raw request error.
 */
export const useAdminUserOrgMembership = (userId: string) => {
  const cache = useQueryClient();
  const membersPath = (organizationId: string) =>
    `/api/admin/organizations/${encodeURIComponent(organizationId)}/members`;
  const memberPath = (organizationId: string) => `${membersPath(organizationId)}/${encodeURIComponent(userId)}`;

  const run = async (request: () => Promise<unknown>, failure: string) => {
    try {
      await request();
    } catch (error) {
      if (isStepUpCancelled(error)) throw error;
      const message = adminUpdateErrorMessage(error, failure);
      toast.error(message);
      throw new Error(message, { cause: error });
    }
    // The active-org pointer can move with membership, so the user queries refresh as well.
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['organizations'] }),
      cache.invalidateQueries({ queryKey: ['users'] }),
      cache.invalidateQueries({ queryKey: ['admin', 'users', userId] }),
    ]);
  };

  return {
    add: (organizationId: string, reason: string) =>
      run(() => api.post(membersPath(organizationId), { userId, reason }), 'They were not added to the organization.'),
    remove: (organizationId: string, reason: string) =>
      run(
        () => api.delete(memberPath(organizationId), { data: { reason } }),
        'They were not removed from the organization.'
      ),
    setRole: (organizationId: string, role: OrgMemberRoleChoice, reason: string) =>
      run(() => api.patch(memberPath(organizationId), { role, reason }), 'The organization role was not changed.'),
    clearHomeOrg: (reason: string) =>
      run(
        () => api.delete(`/api/admin/users/${encodeURIComponent(userId)}/home-organization`, { data: { reason } }),
        'The home org was not cleared.'
      ),
  };
};
