import { createHash, timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import { adminSettingsRepository, inboxRepository, SkillListing } from '@bike4mind/database';
import { rateLimit } from '@server/middlewares/rateLimit';
import { organizationRepository } from '@bike4mind/database/infra';
import {
  BadRequestError,
  InboxType,
  type ISkill,
  type ISkillListing,
  type ISkillListingVersion,
  type ISkillSnapshot,
} from '@bike4mind/common';
import type { ISkillListingDocument } from '@bike4mind/database';

/**
 * Shared Skill Market helpers. The visibility gate lives ONLY in `marketVisibilityFilter` /
 * `canSeeListing`: browse, search, recommendations, similar, detail, import, rating and report all
 * route through them, so they cannot drift apart.
 */

export type MarketActor = { id: string; isAdmin?: boolean };

export type MarketSettings = {
  highRiskTools: string[];
  urlAllowlist: string[];
  minConfidence: number;
  auditSampleRate: number;
  reviewSlaHours: number;
  dailySubmitLimit: number;
  maxListingsPerUser: number;
  publicMinAccountAgeDays: number;
  reportAutoHideThreshold: number;
};

const splitList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

export async function loadMarketSettings(): Promise<MarketSettings> {
  const get = adminSettingsRepository.getSettingsValue.bind(adminSettingsRepository);
  const [tools, allow, minConf, sample, sla, daily, maxListings, minAge, hide] = await Promise.all([
    get('SkillMarketHighRiskTools'),
    get('SkillMarketUrlAllowlist'),
    get('SkillMarketClassifierMinConfidence'),
    get('SkillMarketAuditSampleRate'),
    get('SkillMarketReviewSlaHours'),
    get('SkillMarketDailySubmitLimit'),
    get('SkillMarketMaxListingsPerUser'),
    get('SkillMarketPublicMinAccountAgeDays'),
    get('SkillMarketReportAutoHideThreshold'),
  ]);
  return {
    highRiskTools: splitList(tools),
    urlAllowlist: splitList(allow),
    minConfidence: Number(minConf ?? 0.8),
    auditSampleRate: Number(sample ?? 0.1),
    reviewSlaHours: Number(sla ?? 72),
    dailySubmitLimit: Number(daily ?? 20),
    maxListingsPerUser: Number(maxListings ?? 25),
    publicMinAccountAgeDays: Number(minAge ?? 3),
    reportAutoHideThreshold: Number(hide ?? 3),
  };
}

/** Orgs whose Organization listings the user may see: any membership, plus orgs they run. */
export async function memberOrgIdsFor(userId: string): Promise<string[]> {
  const [member, administered] = await Promise.all([
    organizationRepository.findMembershipOrgIds(userId),
    organizationRepository.findIdsAdministeredBy(userId),
  ]);
  return [...new Set([...member, ...administered])];
}

/**
 * The market's visibility gate as a Mongo filter. Unlisted listings are deliberately absent: they
 * are reachable only by token, never by browse/search/recommendations.
 */
export function marketVisibilityFilter(memberOrgIds: string[]): Record<string, unknown> {
  return {
    status: 'approved',
    deletedAt: null,
    hiddenByReports: { $ne: true },
    $or: [{ visibility: 'public' }, { visibility: 'organization', organizationId: { $in: memberOrgIds } }],
  };
}

const tokenMatches = (expected: string, given: string | undefined): boolean => {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * In-memory twin of `marketVisibilityFilter` for a single listing. Unlisted needs its token, or an
 * earlier import of it (so the importer can see and pull updates without keeping the link). That
 * importer grant is unlisted-only: someone who left an org loses its listings like any non-member.
 */
export function canSeeListing(
  listing: ISkillListing,
  memberOrgIds: string[],
  token?: string,
  hasImported = false
): boolean {
  if (listing.status !== 'approved' || listing.deletedAt || listing.hiddenByReports) return false;
  if (listing.visibility === 'public') return true;
  if (listing.visibility === 'organization') return memberOrgIds.includes(listing.organizationId ?? '');
  return hasImported || tokenMatches(listing.shareToken, token);
}

/**
 * Who may approve/reject/delist/audit a listing. Public and unlisted: super-admins, but never on
 * their own Public listing. Organization: the org's owner or manager (the `verifyOrgAccess`
 * predicate, i.e. `findIdsAdministeredBy`), self-approval allowed, or a super-admin.
 */
export function canReviewListing(listing: ISkillListing, actor: MarketActor, adminOrgIds: string[]): boolean {
  if (listing.visibility === 'organization') {
    return Boolean(actor.isAdmin) || adminOrgIds.includes(listing.organizationId ?? '');
  }
  if (!actor.isAdmin) return false;
  return !(listing.visibility === 'public' && listing.authorUserId === actor.id);
}

/** Delisting is a takedown, so a super-admin may always do it (even on their own listing). */
export function canDelistListing(listing: ISkillListing, actor: MarketActor, adminOrgIds: string[]): boolean {
  return Boolean(actor.isAdmin) || canReviewListing(listing, actor, adminOrgIds);
}

/** Must stay in sync with the restore guard in pages/api/skills/market/[id]/moderate.ts. */
export function canRestoreListing(listing: ISkillListing, actor: MarketActor, adminOrgIds: string[]): boolean {
  if (!canDelistListing(listing, actor, adminOrgIds)) return false;
  if (actor.isAdmin) return true;
  return listing.authorUserId !== actor.id && !(listing.status === 'delisted' && listing.delistedBySuperAdmin);
}

export const isListingAuthor = (listing: ISkillListing, actor: MarketActor): boolean =>
  listing.authorUserId === actor.id;

export const toSnapshot = (skill: ISkill): ISkillSnapshot => ({
  name: skill.name,
  description: skill.description,
  body: skill.body,
  ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  ...(skill.allowedTools?.length ? { allowedTools: [...skill.allowedTools] } : {}),
  disableModelInvocation: Boolean(skill.disableModelInvocation),
});

/**
 * Content identity of a skill, EXCLUDING its name: the name is the importer's slash-command handle
 * and may be changed on import to avoid a collision, which must not read as "locally modified".
 */
export function skillContentHash(
  skill: Pick<ISkill, 'description' | 'body' | 'argumentHint' | 'allowedTools' | 'disableModelInvocation'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        skill.description,
        skill.body,
        skill.argumentHint ?? '',
        skill.allowedTools ?? [],
        Boolean(skill.disableModelInvocation),
      ])
    )
    .digest('hex');
}

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TAGS = 5;

export function validateListingTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BadRequestError('tags must be an array');
  const tags = [...new Set(value.map(t => (typeof t === 'string' ? t.trim().toLowerCase() : '')))];
  if (tags.length > MAX_TAGS) throw new BadRequestError(`At most ${MAX_TAGS} tags`);
  for (const tag of tags) {
    if (!TAG_PATTERN.test(tag)) {
      throw new BadRequestError('Tags are 1-24 lowercase letters, digits or hyphens');
    }
  }
  return tags;
}

/**
 * JSON form of a listing for a viewer. Only a privileged viewer (the author or a reviewer) gets the
 * unlisted share token, the author's private source skill id, and the pending/latest version
 * pointers that would reveal an unreviewed version is waiting.
 */
export function serializeListing(listing: ISkillListing | ISkillListingDocument, opts: { privileged?: boolean } = {}) {
  const plain = (
    'toJSON' in listing && typeof listing.toJSON === 'function' ? listing.toJSON() : listing
  ) as ISkillListing & { _id?: unknown; __v?: unknown };
  const { shareToken, sourceSkillId, pendingVersionId, pendingVersion, latestVersion, _id, __v: _v, ...rest } = plain;
  return {
    ...rest,
    id: String(rest.id ?? _id),
    ratingAvg: rest.ratingCount > 0 ? Math.round((rest.ratingSum / rest.ratingCount) * 10) / 10 : 0,
    ...(opts.privileged ? { shareToken, sourceSkillId, pendingVersionId, pendingVersion, latestVersion } : {}),
  };
}

/** Fields of a version a non-author viewer may see: the approved snapshot and its honest summary. */
export const publicVersionView = (v: ISkillListingVersion) => ({
  id: String(v.id),
  version: v.version,
  snapshot: v.snapshot,
  honestSummary: v.honestSummary,
  riskTier: v.riskTier,
  createdAt: v.createdAt,
});

export async function notifyUser(receiverId: string, title: string, message: string): Promise<void> {
  await inboxRepository.createInboxMessage({ type: InboxType.COMMON, title, message, receiverId, userId: 'SYSTEM' });
}

export async function findListing(id: string): Promise<ISkillListing | null> {
  if (!mongoose.isObjectIdOrHexString(id)) return null;
  const doc = await SkillListing.findOne({ _id: id, deletedAt: null });
  return doc ? (doc.toJSON() as unknown as ISkillListing) : null;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Anti-spam for every scan-triggering route (publish, resubmit, rescan): a burst cap plus the
 * admin-set daily cap. Each scan may cost an LLM call, so this also bounds classifier spend.
 * Super-admins are exempt (seeding, moderation tests).
 */
export const submitRateLimits = () => [
  rateLimit({
    limit: req => (req.user?.isAdmin ? Infinity : 10),
    windowMs: HOUR_MS,
    bucket: 'skill-market-submit',
  }),
  rateLimit({
    limit: async req => (req.user?.isAdmin ? Infinity : (await loadMarketSettings()).dailySubmitLimit),
    windowMs: 24 * HOUR_MS,
    bucket: 'skill-market-submit-daily',
  }),
];
