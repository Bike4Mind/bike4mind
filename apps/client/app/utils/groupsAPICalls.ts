// Typed client for the org-groups routes (org-groups epic #1172, Phase 5 UI). Mirrors the thin
// `partnerSignupRuleAPICalls.ts` pattern: each function wraps the shared axios `api` client and
// returns the unwrapped payload. Two surfaces are covered:
//   - Platform admin: set an org's allowed group types (provisions/revokes Group instances).
//   - Org admin / billing owner: list groups, rename, assign/unassign members, appoint org admins.

import { api } from '@client/app/contexts/ApiContext';
import type { IGroupDocument } from '@bike4mind/common';

/** A group instance plus the membership the management UI needs (see GET groups route). */
export type GroupWithMembers = IGroupDocument & {
  memberIds: string[];
  memberCount: number;
};

/** Result of a platform-admin group-type write (mirrors the service's SetGroupTypesResult). */
export type SetGroupTypesResult = {
  added: string[];
  removed: string[];
  revokedGroupIds: string[];
};

// PUT /api/admin/organizations/:id/group-types - platform-admin only.
export const setOrganizationGroupTypes = async (
  organizationId: string,
  allowedGroupTypes: string[]
): Promise<SetGroupTypesResult> => {
  const response = await api.put<SetGroupTypesResult>(`/api/admin/organizations/${organizationId}/group-types`, {
    allowedGroupTypes,
  });
  return response.data;
};

// GET /api/organizations/:id/groups - list group instances with their members.
export const fetchOrganizationGroups = async (organizationId: string): Promise<GroupWithMembers[]> => {
  const response = await api.get<{ groups: GroupWithMembers[] }>(`/api/organizations/${organizationId}/groups`);
  return response.data.groups;
};

// PATCH /api/organizations/:id/groups/:groupId - rename a group instance.
export const renameOrganizationGroup = async (
  organizationId: string,
  groupId: string,
  name: string
): Promise<IGroupDocument> => {
  const response = await api.patch<{ group: IGroupDocument }>(
    `/api/organizations/${organizationId}/groups/${groupId}`,
    { name }
  );
  return response.data.group;
};

// POST /api/organizations/:id/groups/:groupId/members - assign a member to a group.
export const assignGroupMember = async (organizationId: string, groupId: string, userId: string): Promise<void> => {
  await api.post<{ success: boolean }>(`/api/organizations/${organizationId}/groups/${groupId}/members`, { userId });
};

// DELETE /api/organizations/:id/groups/:groupId/members/:userId - unassign a member from a group.
export const unassignGroupMember = async (organizationId: string, groupId: string, userId: string): Promise<void> => {
  await api.delete<{ success: boolean }>(`/api/organizations/${organizationId}/groups/${groupId}/members/${userId}`);
};

// PUT /api/organizations/:id/admins - set the org's appointed admins (billing owner / platform admin).
export const setOrganizationAdmins = async (organizationId: string, adminUserIds: string[]): Promise<string[]> => {
  const response = await api.put<{ adminUserIds: string[] }>(`/api/organizations/${organizationId}/admins`, {
    adminUserIds,
  });
  return response.data.adminUserIds;
};
