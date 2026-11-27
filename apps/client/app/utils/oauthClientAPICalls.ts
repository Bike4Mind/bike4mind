import { api } from '@client/app/contexts/ApiContext';
import type {
  CreateOAuthClientInput,
  OAuthClientRole,
  OAuthClientRolesView,
  OAuthClientRoleAssignmentInput,
  OAuthClientUsageStats,
  UserOAuthClientRolesView,
  OAuthClientView,
  OAuthClientWithSecret,
  UpdateOAuthClientInput,
} from '@bike4mind/common';

const BASE = '/api/admin/oauth-clients';

export const OAUTH_CLIENTS_QUERY_KEY = 'admin-oauth-clients';
// Not under the list key, so list mutations do not refetch the stats.
export const OAUTH_CLIENT_STATS_QUERY_KEY = 'admin-oauth-client-stats';

export const fetchOAuthClients = async () => {
  const response = await api.get<OAuthClientView[]>(BASE);
  return response.data;
};

export const fetchOAuthClientStats = async () => {
  const response = await api.get<OAuthClientUsageStats>(`${BASE}/stats`);
  return response.data;
};

export const createOAuthClient = async (data: CreateOAuthClientInput) => {
  const response = await api.post<OAuthClientWithSecret>(BASE, data);
  return response.data;
};

export const updateOAuthClient = async (id: string, data: UpdateOAuthClientInput) => {
  const response = await api.patch<OAuthClientView>(`${BASE}/${id}`, data);
  return response.data;
};

export const rotateOAuthClientSecret = async (id: string) => {
  const response = await api.post<OAuthClientWithSecret>(`${BASE}/${id}/rotate-secret`);
  return response.data;
};

export const fetchOAuthClientRoles = async (id: string) => {
  const response = await api.get<OAuthClientRolesView>(`${BASE}/${id}/roles`);
  return response.data;
};

export const addOAuthClientRole = async (id: string, data: OAuthClientRole & { reason: string }) => {
  const response = await api.post<OAuthClientView>(`${BASE}/${id}/roles`, data);
  return response.data;
};

export const removeOAuthClientRole = async (id: string, key: string, reason: string) => {
  const response = await api.delete<OAuthClientView>(`${BASE}/${id}/roles/${encodeURIComponent(key)}`, {
    data: { reason },
  });
  return response.data;
};

const userRolesUrl = (userId: string) => `/api/admin/users/${userId}/oauth-client-roles`;

export const fetchUserOAuthClientRoles = async (userId: string) => {
  const response = await api.get<UserOAuthClientRolesView[]>(userRolesUrl(userId));
  return response.data;
};

export const assignUserOAuthClientRole = async (
  userId: string,
  data: OAuthClientRoleAssignmentInput & { reason: string }
) => {
  await api.post(userRolesUrl(userId), data);
};

export const unassignUserOAuthClientRole = async (
  userId: string,
  data: OAuthClientRoleAssignmentInput & { reason: string }
) => {
  await api.delete(userRolesUrl(userId), { data });
};
