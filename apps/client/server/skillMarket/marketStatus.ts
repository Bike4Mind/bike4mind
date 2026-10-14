import { SkillListing } from '@bike4mind/database';
import type { ISkill, ISkillMarketStatus } from '@bike4mind/common';
import { skillContentHash } from './market';

/**
 * Attach `marketStatus` to every imported skill in a page: stale when its listing has a newer
 * approved version, delisted / removed when the listing was taken down / withdrawn, and
 * `locallyModified` when the importer edited the copy. One batched listing lookup per page (no N+1).
 */
export async function attachMarketStatus<T extends ISkill>(
  skills: T[]
): Promise<Array<T & { marketStatus?: ISkillMarketStatus }>> {
  const listingIds = [...new Set(skills.flatMap(s => (s.importedFrom ? [s.importedFrom.listingId] : [])))];
  if (listingIds.length === 0) return skills;

  const listings = await SkillListing.find({ _id: { $in: listingIds } })
    .select('status currentVersion deletedAt')
    .lean();
  const byId = new Map(listings.map(l => [String(l._id), l]));

  return skills.map(skill => {
    const from = skill.importedFrom;
    if (!from) return skill;
    const listing = byId.get(from.listingId);
    const locallyModified = skillContentHash(skill) !== from.contentHash;
    let state: ISkillMarketStatus['state'] = 'current';
    if (!listing || listing.deletedAt || listing.status === 'withdrawn') state = 'removed';
    else if (listing.status === 'delisted') state = 'delisted';
    else if ((listing.currentVersion ?? 0) > from.version) state = 'stale';
    return {
      ...skill,
      marketStatus: {
        state,
        importedVersion: from.version,
        ...(listing?.currentVersion ? { latestVersion: listing.currentVersion } : {}),
        locallyModified,
      },
    };
  });
}
