import { api } from '@client/app/contexts/ApiContext';
import type {
  CreateGrantPackageInput,
  GrantPackageReasonPolicy,
  IGrantPackageDocument,
  PaginatedResponse,
  UpdateGrantPackageInput,
} from '@bike4mind/common';

const BASE = '/api/admin/grant-packages';

export const GRANT_PACKAGES_QUERY_KEY = 'admin-grant-packages';

/** Present only when the list is fetched with `usage: true`. nextCodeExpiry is an ISO string or null. */
export type GrantPackageUsage = {
  codes: number;
  activeCodes: number;
  nextCodeExpiry: string | null;
  partnerDomains: number;
  enabledPartnerDomains: number;
};

export type GrantPackageRow = IGrantPackageDocument & { redeemedToday: number; usage?: GrantPackageUsage };

export type GrantPackageList = PaginatedResponse<GrantPackageRow> & { reasonPolicy: GrantPackageReasonPolicy };

export const fetchGrantPackages = async ({ usage, ...params }: { page?: number; limit?: number; usage?: boolean }) => {
  const response = await api.get<GrantPackageList>(BASE, { params: usage ? { ...params, usage: '1' } : params });
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
