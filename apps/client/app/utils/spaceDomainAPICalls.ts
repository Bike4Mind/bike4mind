// Typed client for the Space domain claim routes (pages/api/spaces/[id]/domains).

import { api } from '@client/app/contexts/ApiContext';
import type { IOrgDomainClaimView, UpdateSpaceDomainPolicyInput } from '@bike4mind/common';
import type { VerifyOrgDomainResult } from '@client/app/utils/orgDomainAPICalls';

const base = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/domains`;

export const fetchSpaceDomainClaims = async (spaceId: string): Promise<IOrgDomainClaimView[]> => {
  const response = await api.get<{ claims: IOrgDomainClaimView[] }>(base(spaceId));
  return response.data.claims;
};

export const addSpaceDomainClaim = async (spaceId: string, domain: string): Promise<IOrgDomainClaimView> => {
  const response = await api.post<{ claim: IOrgDomainClaimView }>(base(spaceId), { domain });
  return response.data.claim;
};

export const verifySpaceDomainClaim = async (spaceId: string, claimId: string): Promise<VerifyOrgDomainResult> => {
  const response = await api.post<VerifyOrgDomainResult>(`${base(spaceId)}/${encodeURIComponent(claimId)}/verify`);
  return response.data;
};

export const updateSpaceDomainClaimPolicy = async (
  spaceId: string,
  claimId: string,
  update: UpdateSpaceDomainPolicyInput
): Promise<IOrgDomainClaimView> => {
  const response = await api.patch<{ claim: IOrgDomainClaimView }>(
    `${base(spaceId)}/${encodeURIComponent(claimId)}`,
    update
  );
  return response.data.claim;
};

export const deleteSpaceDomainClaim = async (spaceId: string, claimId: string): Promise<void> => {
  await api.delete(`${base(spaceId)}/${encodeURIComponent(claimId)}`);
};
