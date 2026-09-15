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

/** Minimal org shape the rule form needs: an id to store, a name to display. */
export type OrganizationOption = { id: string; name: string };

/** Search organizations by name for the rule's org picker (admin-scoped list endpoint). */
export const searchOrganizations = async (query: string): Promise<OrganizationOption[]> => {
  const response = await api.get<{ data: OrganizationOption[] }>('/api/organizations', {
    params: { query, pagination: { page: 1, limit: 20 } },
  });
  return response.data.data.map(({ id, name }) => ({ id, name }));
};

/** Fetch a single org (to seed the picker's selected label when editing a rule with an org). */
export const fetchOrganizationById = async (id: string): Promise<OrganizationOption | null> => {
  const response = await api.get<OrganizationOption>(`/api/organizations/${id}`);
  return response.data ? { id: response.data.id, name: response.data.name } : null;
};

export type BackfillPreview = {
  dryRun: true;
  organizationId: string;
  domain: string;
  matched: number;
  /** Current seat ceiling and the projected ceiling after commit (#1239 - the seat blast radius). */
  seats: number;
  projectedSeats: number;
  /** Stripe-billed orgs keep their ceiling (candidates past it are rejected, never silently billed). */
  stripeBilled: boolean;
  sample: Array<{ id: string; email?: string; name: string }>;
};

export type BackfillResult = {
  dryRun: false;
  organizationId: string;
  domain: string;
  matched: number;
  added: number;
  /** Adds that also raised the org's seat ceiling (subset of `added`, non-Stripe orgs only). */
  seatRaised: number;
  alreadyMember: number;
  /** Candidates a full Stripe-billed org couldn't admit without an out-of-band (billed) seat raise. */
  atCapacity: number;
  unverified: number;
  failed: number;
};

const BACKFILL = `${BASE}/backfill`;

/** Preview (dry-run) which existing verified-domain users would be added to the rule's org. */
export const previewPartnerRuleBackfill = async (id: string): Promise<BackfillPreview> => {
  const response = await api.post<BackfillPreview>(BACKFILL, { id, commit: false });
  return response.data;
};

/** Commit the backfill: add the matched users to the rule's org. */
export const runPartnerRuleBackfill = async (id: string): Promise<BackfillResult> => {
  const response = await api.post<BackfillResult>(BACKFILL, { id, commit: true });
  return response.data;
};
