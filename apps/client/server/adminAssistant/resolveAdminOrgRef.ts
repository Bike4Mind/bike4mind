import { organizationRepository } from '@bike4mind/database';
import type { IOrganizationDocument } from '@bike4mind/common';
import type { AdminToolResult } from './defineAdminTool';
import type { AdminOrgRef } from './schemas';

const MAX_NAME_MATCHES = 10;

type OrgRefFailure = Extract<AdminToolResult, { ok: false }>;

export type OrgRefResolution = { ok: true; org: IOrganizationDocument } | OrgRefFailure;

const notFound: OrgRefFailure = { ok: false, error: 'not_found', message: 'No organization matches that id or name.' };

/**
 * A name resolves on a single case-insensitive exact match, else on a single partial match;
 * anything else is `ambiguous` with the candidates so the model can ask or retry with orgId.
 */
export async function resolveAdminOrgRef(ref: AdminOrgRef): Promise<OrgRefResolution> {
  if (ref.orgId !== undefined) {
    const org = await organizationRepository.findById(ref.orgId);
    return org ? { ok: true, org } : notFound;
  }
  if (ref.name === undefined) return notFound;

  // search() escapes the name and matches it as a case-insensitive substring.
  const matches = await organizationRepository.search(
    '',
    { name: ref.name },
    { page: 1, limit: MAX_NAME_MATCHES },
    { field: 'name', direction: 'asc' }
  );
  const wanted = ref.name.toLowerCase();
  const exact = matches.data.filter(org => org.name.toLowerCase() === wanted);

  if (exact.length === 1) return { ok: true, org: exact[0] };
  if (exact.length === 0 && matches.data.length === 1) return { ok: true, org: matches.data[0] };
  if (matches.data.length === 0) return notFound;

  const candidates = exact.length > 1 ? exact : matches.data;
  return {
    ok: false,
    error: 'ambiguous',
    message: 'Several organizations match that name. Ask which one, or retry with its orgId.',
    candidates: candidates.map(org => ({ id: org.id, name: org.name, personal: org.personal })),
  };
}
