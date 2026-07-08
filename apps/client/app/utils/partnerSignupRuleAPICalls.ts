import { api } from '@client/app/contexts/ApiContext';
import type {
  IPartnerSignupRuleDocument,
  PaginatedResponse,
  CreatePartnerSignupRuleInput,
  UpdatePartnerSignupRuleInput,
} from '@bike4mind/common';

const BASE = '/api/admin/partner-signup-rules';

export const fetchPartnerSignupRules = async (params: { page?: number; limit?: number; search?: string }) => {
  const response = await api.get<PaginatedResponse<IPartnerSignupRuleDocument>>(BASE, { params });
  return response.data;
};

export const createPartnerSignupRule = async (data: CreatePartnerSignupRuleInput) => {
  const response = await api.post<IPartnerSignupRuleDocument>(BASE, data);
  return response.data;
};

export const updatePartnerSignupRule = async (id: string, data: UpdatePartnerSignupRuleInput) => {
  const response = await api.put<IPartnerSignupRuleDocument>(`${BASE}/${id}`, data);
  return response.data;
};

export const deletePartnerSignupRule = async (id: string) => {
  const response = await api.delete<{ success: boolean }>(`${BASE}/${id}`);
  return response.data;
};
