// Typed client for the org-admin domain claim routes (pages/api/organizations/[id]/domains).

import { api } from '@client/app/contexts/ApiContext';
import type { IOrgDomainClaimView, UpdateOrgDomainPolicyInput } from '@bike4mind/common';

export type VerifyOrgDomainResult =
  { verified: true; claim: IOrgDomainClaimView } | { verified: false; reason: string };

const base = (organizationId: string) => `/api/organizations/${encodeURIComponent(organizationId)}/domains`;

export const fetchOrgDomainClaims = async (organizationId: string): Promise<IOrgDomainClaimView[]> => {
  const response = await api.get<{ claims: IOrgDomainClaimView[] }>(base(organizationId));
  return response.data.claims;
};

export const addOrgDomainClaim = async (organizationId: string, domain: string): Promise<IOrgDomainClaimView> => {
  const response = await api.post<{ claim: IOrgDomainClaimView }>(base(organizationId), { domain });
  return response.data.claim;
};

export const verifyOrgDomainClaim = async (organizationId: string, claimId: string): Promise<VerifyOrgDomainResult> => {
  const response = await api.post<VerifyOrgDomainResult>(
    `${base(organizationId)}/${encodeURIComponent(claimId)}/verify`
  );
  return response.data;
};

export const updateOrgDomainClaimPolicy = async (
  organizationId: string,
  claimId: string,
  update: UpdateOrgDomainPolicyInput
): Promise<IOrgDomainClaimView> => {
  const response = await api.patch<{ claim: IOrgDomainClaimView }>(
    `${base(organizationId)}/${encodeURIComponent(claimId)}`,
    update
  );
  return response.data.claim;
};

export const deleteOrgDomainClaim = async (organizationId: string, claimId: string): Promise<void> => {
  await api.delete(`${base(organizationId)}/${encodeURIComponent(claimId)}`);
};

export interface OrgDomainJoinSuggestion {
  organizationId: string;
  organizationName: string;
  claimId: string;
}

export const fetchOrgDomainJoinSuggestions = async (): Promise<OrgDomainJoinSuggestion[]> => {
  const response = await api.get<{ suggestions: OrgDomainJoinSuggestion[] }>('/api/organizations/domain-suggestions');
  return response.data.suggestions;
};

export const joinOrgViaDomain = async (organizationId: string): Promise<{ joined: boolean }> => {
  const response = await api.post<{ joined: boolean }>(
    `/api/organizations/${encodeURIComponent(organizationId)}/domain-join`
  );
  return response.data;
};
