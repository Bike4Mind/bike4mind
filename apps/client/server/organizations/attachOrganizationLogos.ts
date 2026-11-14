import { AppFile } from '@bike4mind/database/content';

type OrgWithLogo = { logoFileId?: unknown; logo?: unknown };

/**
 * Fills the `logo` virtual (only `id` and `path`, all the client reads to build the CDN URL) on
 * already-serialized organizations. No organization read populates it, so without this the team
 * card and the team page header never see an uploaded logo. One query for the whole list.
 */
export async function attachOrganizationLogos<T extends OrgWithLogo | null>(organizations: T[]): Promise<T[]> {
  const logoIds = [...new Set(organizations.flatMap(org => (org?.logoFileId ? [String(org.logoFileId)] : [])))];
  if (logoIds.length === 0) return organizations;

  const files = await AppFile.find({ _id: { $in: logoIds } })
    .select('path')
    .lean<{ _id: unknown; path: string }[]>();
  const pathById = new Map(files.map(file => [String(file._id), file.path]));

  return organizations.map(org => {
    if (!org?.logoFileId) return org;
    const id = String(org.logoFileId);
    const path = pathById.get(id);
    return path ? { ...org, logo: { id, path } } : org;
  });
}
