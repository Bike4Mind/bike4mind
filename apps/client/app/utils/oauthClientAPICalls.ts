import { api } from '@client/app/contexts/ApiContext';
import type {
  CreateOAuthClientInput,
  OAuthClientView,
  OAuthClientWithSecret,
  UpdateOAuthClientInput,
} from '@bike4mind/common';

const BASE = '/api/admin/oauth-clients';

export const fetchOAuthClients = async () => {
  const response = await api.get<OAuthClientView[]>(BASE);
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
