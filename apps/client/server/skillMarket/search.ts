import type { PipelineStage } from 'mongoose';
import { SkillListing, SkillListingImport, skillRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { marketVisibilityFilter, serializeListing } from '@bike4mind/server-utils/skillMarket/market';

/**
 * Market search and the rule-based recommendation rails. Every query starts from
 * `marketVisibilityFilter`, so nothing here can surface a pending, delisted, hidden, unlisted or
 * other-org listing.
 */

/** Bayesian average prior: C pseudo-ratings of M stars, so one 5-star review can't top the chart. */
export const BAYES_C = 5;
export const BAYES_M = 3.5;

export type MarketSort = 'relevance' | 'top' | 'imports' | 'new' | 'updated';

export type MarketSearchParams = {
  q?: string;
  scope?: 'public' | 'org';
  tags?: string[];
  tools?: 'with' | 'without';
  minRating?: number;
  sort?: MarketSort;
  page: number;
  limit: number;
};

const SORTS: Record<Exclude<MarketSort, 'relevance'>, Record<string, 1 | -1>> = {
  top: { bayes: -1, ratingCount: -1, _id: -1 },
  imports: { importCount: -1, _id: -1 },
  new: { createdAt: -1, _id: -1 },
  updated: { publishedAt: -1, _id: -1 },
};

export async function searchListings(memberOrgIds: string[], params: MarketSearchParams) {
  const match: Record<string, unknown> = { ...marketVisibilityFilter(memberOrgIds) };
  const q = params.q?.trim().slice(0, 200);
  // $text must sit in the pipeline's first $match.
  if (q) match.$text = { $search: q };
  if (params.scope === 'public') match.visibility = 'public';
  if (params.scope === 'org') match.visibility = 'organization';
  if (params.tags?.length) match.tags = { $in: params.tags };
  if (params.tools === 'with') match.usesTools = true;
  if (params.tools === 'without') match.usesTools = { $ne: true };

  const sort =
    params.sort === 'relevance' && q
      ? { score: -1 as const, _id: -1 as const }
      : SORTS[params.sort === 'relevance' || !params.sort ? 'top' : params.sort];

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $addFields: {
        bayes: { $divide: [{ $add: [BAYES_C * BAYES_M, '$ratingSum'] }, { $add: [BAYES_C, '$ratingCount'] }] },
        avg: { $cond: [{ $gt: ['$ratingCount', 0] }, { $divide: ['$ratingSum', '$ratingCount'] }, 0] },
        ...(q ? { score: { $meta: 'textScore' } } : {}),
      },
    },
    ...(params.minRating ? [{ $match: { avg: { $gte: params.minRating } } }] : []),
    { $sort: sort },
    { $skip: (params.page - 1) * params.limit },
    { $limit: params.limit + 1 },
    { $project: { shareToken: 0 } },
  ];

  const rows = await SkillListing.aggregate(pipeline);
  const hasMore = rows.length > params.limit;
  return { data: rows.slice(0, params.limit).map(r => serializeListing(r)), hasMore };
}

type Recommendation = ReturnType<typeof serializeListing> & { reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const RAIL_SIZE = 12;
// ponytail: org-popularity scans imports by an $in of member ids, capped here; switch to a per-org
// import counter on the listing if large orgs make this slow.
const ORG_MEMBER_CAP = 5000;

async function topImported(since: Date, userIds?: string[]): Promise<string[]> {
  const rows = await SkillListingImport.aggregate<{ _id: string }>([
    { $match: { importedAt: { $gte: since }, ...(userIds ? { userId: { $in: userIds } } : {}) } },
    { $group: { _id: '$listingId', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 30 },
  ]);
  return rows.map(r => r._id);
}

const textQueryFor = (name: string): string => name.replace(/-/g, ' ').slice(0, 100);

/** "Recommended for you": popular in your orgs, similar to what you use, then trending. */
export async function recommendListings(userId: string, memberOrgIds: string[]): Promise<Recommendation[]> {
  const myImports = await SkillListingImport.find({ userId }).select('listingId stars').lean();
  const excluded = new Set(myImports.map(i => i.listingId));

  const candidates: Array<{ id: string; reason: string }> = [];

  for (const orgId of memberOrgIds.slice(0, 3)) {
    const [org, members] = await Promise.all([
      organizationRepository.findById(orgId),
      organizationRepository.findMemberUserIds(orgId),
    ]);
    const ids = await topImported(new Date(Date.now() - 30 * DAY_MS), members.userIds.slice(0, ORG_MEMBER_CAP));
    for (const id of ids) candidates.push({ id, reason: `Popular in ${org?.name ?? 'your organization'}` });
  }

  // Similar to skills you imported or wrote: text-match their names against the market.
  const importedListings = await SkillListing.find({ _id: { $in: [...excluded] } })
    .select('name')
    .limit(5)
    .lean();
  const ownSkills = await skillRepository.listForUser(userId);
  const anchors = [
    ...importedListings.map(l => l.name),
    ...ownSkills.filter(s => !s.importedFrom).map(s => s.name),
  ].slice(0, 5);
  for (const anchor of anchors) {
    const similar = await SkillListing.find(
      { ...marketVisibilityFilter(memberOrgIds), $text: { $search: textQueryFor(anchor) } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(3)
      .select('_id')
      .lean();
    for (const s of similar) candidates.push({ id: String(s._id), reason: `Similar to /${anchor}` });
  }

  for (const id of await topImported(new Date(Date.now() - 7 * DAY_MS))) {
    candidates.push({ id, reason: 'Trending this week' });
  }

  const reasonById = new Map<string, string>();
  for (const c of candidates) if (!excluded.has(c.id) && !reasonById.has(c.id)) reasonById.set(c.id, c.reason);
  if (reasonById.size === 0) return [];

  // Re-check every candidate through the visibility gate; own listings are not recommendations.
  const visible = await SkillListing.find({
    ...marketVisibilityFilter(memberOrgIds),
    _id: { $in: [...reasonById.keys()] },
    authorUserId: { $ne: userId },
  });
  const byId = new Map(visible.map(l => [String(l._id), l]));
  const out: Recommendation[] = [];
  for (const [id, reason] of reasonById) {
    const listing = byId.get(id);
    if (listing) out.push({ ...serializeListing(listing), reason });
    if (out.length >= RAIL_SIZE) break;
  }
  return out;
}

/** "Similar skills" on a detail page: shared tags first, then name/summary text similarity. */
export async function similarListings(
  listing: { id: string; name: string; tags: string[] },
  userId: string,
  memberOrgIds: string[]
): Promise<Recommendation[]> {
  // Already-imported listings (which include everything this user rated) are not suggestions.
  const imported = await SkillListingImport.find({ userId }).select('listingId').lean();
  const exclude = [listing.id, ...imported.map(r => r.listingId)];
  const base = { ...marketVisibilityFilter(memberOrgIds), _id: { $nin: exclude } };

  const out: Recommendation[] = [];
  if (listing.tags.length) {
    const byTag = await SkillListing.find({ ...base, tags: { $in: listing.tags } })
      .sort({ importCount: -1 })
      .limit(6);
    for (const l of byTag) {
      const shared = l.tags.filter(t => listing.tags.includes(t));
      out.push({ ...serializeListing(l), reason: `Shares tag ${shared.slice(0, 2).join(', ')}` });
    }
  }
  if (out.length < 6) {
    const seen = new Set(out.map(o => o.id));
    const byText = await SkillListing.find(
      { ...base, $text: { $search: textQueryFor(listing.name) } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' } })
      .limit(6);
    for (const l of byText) {
      if (out.length >= 6) break;
      if (!seen.has(String(l._id))) out.push({ ...serializeListing(l), reason: 'Similar name or purpose' });
    }
  }
  return out;
}
