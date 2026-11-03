import { api } from '@client/app/contexts/ApiContext';
import type {
  CreateGrantPackageInput,
  GrantPackageReasonPolicy,
  IGrantPackageDocument,
  PaginatedResponse,
  UpdateGrantPackageInput,
} from '@bike4mind/common';

const BASE = '/api/admin/grant-packages';

export type GrantPackageRow = IGrantPackageDocument & { redeemedToday: number };

export type GrantPackageList = PaginatedResponse<GrantPackageRow> & { reasonPolicy: GrantPackageReasonPolicy };

export const fetchGrantPackages = async (params: { page?: number; limit?: number }) => {
  const response = await api.get<GrantPackageList>(BASE, { params });
  return response.data;
};

export const createGrantPackage = async (data: CreateGrantPackageInput & { reason?: string }) => {
  const response = await api.post<IGrantPackageDocument>(BASE, data);
  return response.data;
};

export const updateGrantPackage = async (id: string, data: UpdateGrantPackageInput & { reason?: string }) => {
  const response = await api.patch<IGrantPackageDocument>(`${BASE}/${id}`, data);
  return response.data;
};
