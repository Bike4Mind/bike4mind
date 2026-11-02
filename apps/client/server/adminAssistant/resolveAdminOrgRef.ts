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

// Anchored, so an exact name is found however many partial matches sort ahead of it.
const findExactNameMatches = async (name: string): Promise<OrgCandidate[]> => {
  const rows = await Organization.find({ name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' } })
    .select('_id name personal')
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

  const exact = await findExactNameMatches(ref.name);
  if (exact.length === 1) return resolveById(exact[0].id);
  if (exact.length > 1) return ambiguous(exact.slice(0, MAX_NAME_MATCHES), exact.length > MAX_NAME_MATCHES);

  // search() escapes the name and matches it as a case-insensitive substring.
  const partial = await organizationRepository.search(
    '',
    { name: ref.name },
    { page: 1, limit: MAX_NAME_MATCHES },
    { field: 'name', direction: 'asc' }
  );
  if (partial.data.length === 0) return notFound;
  if (partial.data.length === 1) return { ok: true, org: partial.data[0] };
  return ambiguous(
    partial.data.map(org => ({ id: org.id, name: org.name, personal: org.personal })),
    partial.hasMore
  );
}
