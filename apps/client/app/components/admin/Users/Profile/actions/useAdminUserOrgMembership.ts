import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { adminUpdateErrorMessage } from './useAdminUserUpdate';

export type OrgMemberRoleChoice = 'manager' | 'member';

/**
 * Audited org membership writes for one user (pages/api/admin/organizations/[id]/members). Failures
 * toast here and rethrow, so an ActionDialog stays open and an undo reports its own failure.
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
      if (!isStepUpCancelled(error)) toast.error(adminUpdateErrorMessage(error, failure));
      throw error;
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
  };
};
