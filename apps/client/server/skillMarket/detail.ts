import { SkillListingImport, SkillListingVersion, skillRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { NotFoundError, type ISkillListing, type ISkillListingVersion } from '@bike4mind/common';
import {
  canDelistListing,
  canReviewListing,
  canSeeListing,
  isListingAuthor,
  memberOrgIdsFor,
  publicVersionView,
  serializeListing,
  type MarketActor,
} from './market';
import { similarListings } from './search';

/**
 * What a listing page shows a given viewer. Market viewers get only the current APPROVED version;
 * the author and reviewers can also open a listing that is not (or no longer) live, which is how
 * reviewers reach delisted or hidden listings. Anyone else gets a 404 (no existence leak).
 */
export async function buildListingDetail(listing: ISkillListing, actor: MarketActor, token?: string) {
  const [memberOrgIds, adminOrgIds] = await Promise.all([
    memberOrgIdsFor(actor.id),
    organizationRepository.findIdsAdministeredBy(actor.id),
  ]);
  const listingId = String(listing.id);
  const myImport = await SkillListingImport.findOne({ listingId, userId: actor.id }).lean();
  const visible = canSeeListing(listing, memberOrgIds, token, Boolean(myImport));
  const isAuthor = isListingAuthor(listing, actor);
  const canModerate = canDelistListing(listing, actor, adminOrgIds);
  if (!visible && !isAuthor && !canModerate) throw new NotFoundError('Listing not found');

  const [versionDoc, ratingRows] = await Promise.all([
    listing.currentApprovedVersionId ? SkillListingVersion.findById(listing.currentApprovedVersionId) : null,
    SkillListingImport.find({ listingId, stars: { $gte: 1 } })
      .sort({ ratedAt: -1 })
      .limit(20)
      .lean(),
  ]);

  // The importer's copy may have been deleted since; only offer "Update" when it still exists.
  const myCopy = myImport ? await skillRepository.findById(myImport.skillId) : null;

  return {
    listing: serializeListing(listing, { privileged: isAuthor || canModerate }),
    version: versionDoc ? publicVersionView(versionDoc.toJSON() as unknown as ISkillListingVersion) : null,
    // Ratings are shown anonymously as "verified importer" reviews.
    ratings: ratingRows.map(r => ({
      stars: r.stars,
      review: r.review,
      ratedAt: r.ratedAt,
      mine: r.userId === actor.id,
    })),
    myImport: myImport
      ? {
          version: myImport.version,
          stars: myImport.stars,
          review: myImport.review,
          skill:
            myCopy && myCopy.userId === actor.id && !myCopy.deletedAt
              ? { id: String(myCopy.id), name: myCopy.name }
              : null,
        }
      : null,
    viewer: {
      isAuthor,
      canReview: canReviewListing(listing, actor, adminOrgIds),
      canDelist: canModerate,
      canImport: visible && !isAuthor,
      canRate: visible && !isAuthor && Boolean(myImport),
    },
    similar: visible
      ? await similarListings({ id: listingId, name: listing.name, tags: listing.tags }, actor.id, memberOrgIds)
      : [],
  };
}
