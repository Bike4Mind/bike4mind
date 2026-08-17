import { DATALAKE_TAG_PREFIX } from '@bike4mind/common';
import type { IFabFileDocument, ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * Resolve the one lake a tree file can be removed from. The chat tree is cross-lake but the
 * removal endpoint is per-lake, so ownership is derived from the file's `datalake:` membership
 * meta-tag matched against the caller's lake list. Deliberately conservative - returns null
 * (hide the action) unless EXACTLY one accessible lake matches AND the caller can manage it:
 * prefix-only files carry no membership tag, and fallback lakes are server-side read-only and
 * arrive with canManage unset.
 */
export function resolveManageableLake(
  file: Pick<IFabFileDocument, 'tags'>,
  lakes: ManageableDataLakeConfig[] | undefined
): ManageableDataLakeConfig | null {
  if (!lakes?.length) return null;
  const memberTags = (file.tags ?? []).map(t => t.name).filter(name => name.startsWith(DATALAKE_TAG_PREFIX));
  if (memberTags.length === 0) return null;
  const owners = lakes.filter(l => memberTags.includes(l.datalakeTag));
  if (owners.length !== 1) return null;
  return owners[0].canManage ? owners[0] : null;
}
