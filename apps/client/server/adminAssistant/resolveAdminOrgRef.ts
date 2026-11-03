import { Organization, organizationRepository } from '@bike4mind/database';
import type { IOrganizationDocument } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import type { AdminToolResult } from './defineAdminTool';
import type { AdminOrgRef } from './schemas';

const MAX_NAME_MATCHES = 10;

type OrgRefFailure = Extract<AdminToolResult, { ok: false }>;

export type OrgRefResolution = { ok: true; org: IOrganizationDocument } | OrgRefFailure;

type OrgCandidate = { id: string; name: string; personal: boolean };

const notFound: OrgRefFailure = { ok: false, error: 'not_found', message: 'No organization matches that id or name.' };

const ambiguous = (candidates: OrgCandidate[], truncated: boolean): OrgRefFailure => ({
  ok: false,
  error: 'ambiguous',
  message: truncated
    ? `More than ${MAX_NAME_MATCHES} organizations match that name; these are the first. Ask for a more specific name, or retry with an orgId.`
    : 'Several organizations match that name. Ask which one, or retry with its orgId.',
  candidates,
});

const resolveById = async (orgId: string): Promise<OrgRefResolution> => {
  const org = await organizationRepository.findById(orgId);
  return org ? { ok: true, org } : notFound;
};

const findNameMatches = async (pattern: string): Promise<OrgCandidate[]> => {
  const rows = await Organization.find({ name: { $regex: pattern, $options: 'i' } })
    .select('_id name personal')
    .sort({ name: 1 })
    .limit(MAX_NAME_MATCHES + 1)
    .lean<{ _id: unknown; name: string; personal: boolean }[]>();
  return rows.map(row => ({ id: String(row._id), name: row.name, personal: row.personal }));
};

/**
 * A name resolves on a single case-insensitive exact match, else on a single partial match;
 * anything else is `ambiguous` with the candidates so the model can ask or retry with orgId.
 */
export async function resolveAdminOrgRef(ref: AdminOrgRef): Promise<OrgRefResolution> {
  if (ref.orgId !== undefined) return resolveById(ref.orgId);
  if (ref.name === undefined) return notFound;

  const resolveMatches = async (matches: OrgCandidate[]): Promise<OrgRefResolution | null> => {
    if (matches.length === 1) return resolveById(matches[0].id);
    if (matches.length > 1) return ambiguous(matches.slice(0, MAX_NAME_MATCHES), matches.length > MAX_NAME_MATCHES);
    return null;
  };

  // Anchored, so an exact name is found however many partial matches sort ahead of it.
  const escaped = escapeRegex(ref.name);
  const exact = await resolveMatches(await findNameMatches(`^${escaped}$`));
  if (exact) return exact;
  return (await resolveMatches(await findNameMatches(escaped))) ?? notFound;
}
