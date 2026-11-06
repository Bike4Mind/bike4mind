import { timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import { adminSettingsRepository, inboxRepository, SkillListing, SkillListingVersion } from '@bike4mind/database';
import type { RequestHandler } from 'express';
import { rateLimit } from '../middlewares/rateLimit';
import { organizationRepository } from '@bike4mind/database/infra';
import {
  BadRequestError,
  InboxType,
  compareSkillFilePaths,
  SKILL_LISTING_MAX_TAGS as MAX_TAGS,
  SKILL_LISTING_TAG_PATTERN as TAG_PATTERN,
  type ISkill,
  type ISkillListing,
  type ISkillListingVersion,
  type ISkillSnapshot,
} from '@bike4mind/common';
import type { ISkillListingDocument } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'skillMarket' } });

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

/**
 * An admin setting as a number, falling back to `fallback` when it is unset or not finite (a typo
 * like 'abc' must not become NaN and silently disable a cap). `positive` also rejects 0 and below.
 */
export function numericSetting(value: unknown, fallback: number, opts: { positive?: boolean } = {}): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (opts.positive && parsed <= 0) return fallback;
  return parsed;
}

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
    minConfidence: numericSetting(minConf, 0.8),
    auditSampleRate: numericSetting(sample, 0.1),
    reviewSlaHours: numericSetting(sla, 72, { positive: true }),
    dailySubmitLimit: numericSetting(daily, 20, { positive: true }),
    maxListingsPerUser: numericSetting(maxListings, 25, { positive: true }),
    publicMinAccountAgeDays: numericSetting(minAge, 3),
    reportAutoHideThreshold: numericSetting(hide, 3, { positive: true }),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an account is old enough to put content in front of everyone: publishing a Public listing
 * (publish.ts) and saving a global skill (globalSkillUpdate.ts). Super-admins always pass.
 */
export function meetsPublicAccountAge(
  user: { isAdmin?: boolean; createdAt?: Date | string },
  settings: Pick<MarketSettings, 'publicMinAccountAgeDays'>
): boolean {
  if (user.isAdmin) return true;
  const ageDays = (Date.now() - new Date(user.createdAt ?? Number.NaN).getTime()) / DAY_MS;
  return ageDays >= settings.publicMinAccountAgeDays;
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
  ...(skill.claudeCodeAllowedTools?.length ? { claudeCodeAllowedTools: [...skill.claudeCodeAllowedTools] } : {}),
  disableModelInvocation: Boolean(skill.disableModelInvocation),
  ...(skill.files?.length
    ? {
        files: [...skill.files].sort(compareSkillFilePaths).map(({ path, content }) => ({ path, content })),
      }
    : {}),
});

export { skillContentHash } from './contentHash';

export { TAG_PATTERN, MAX_TAGS };

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
  const {
    shareToken,
    sourceSkillId,
    pendingVersionId,
    pendingVersion,
    latestVersion,
    _id,
    __v: _v,
    activeSlot: _activeSlot,
    ...rest
  } = plain as typeof plain & { activeSlot?: boolean };
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

/**
 * Best-effort inbox notice. Every caller has already committed its state change, so a failed
 * notice is logged and swallowed rather than turning a committed action into a 500.
 */
export async function notifyUser(receiverId: string, title: string, message: string): Promise<void> {
  try {
    await inboxRepository.createInboxMessage({ type: InboxType.COMMON, title, message, receiverId, userId: 'SYSTEM' });
  } catch (error) {
    logger.error(`[SKILL_MARKET] inbox notice failed receiver=${receiverId} title=${JSON.stringify(title)}`, error);
  }
}

export async function findListing(id: string): Promise<ISkillListing | null> {
  if (!mongoose.isObjectIdOrHexString(id)) return null;
  const doc = await SkillListing.findOne({ _id: id, deletedAt: null });
  return doc ? (doc.toJSON() as unknown as ISkillListing) : null;
}

/**
 * Take a listing off the market. Importers keep their copies and see "no longer available"; a held
 * version is superseded so it can't be approved later. False when it was already withdrawn or delisted.
 */
export async function withdrawListing(listingId: string): Promise<boolean> {
  const before = await SkillListing.findOneAndUpdate(
    { _id: listingId, status: { $nin: ['withdrawn', 'delisted'] } },
    { $set: { status: 'withdrawn', pendingVersionId: null, pendingVersion: null }, $unset: { activeSlot: 1 } },
    { new: false }
  );
  if (!before) return false;
  await SkillListingVersion.updateMany(
    // Defensive: never supersede the version the listing serves. Read from the pre-image, since a
    // concurrent approve could have moved the pointer since the caller read the listing.
    { listingId: String(listingId), reviewStatus: 'pending', _id: { $ne: before.currentApprovedVersionId } },
    { $set: { reviewStatus: 'superseded' } }
  );
  return true;
}

/** Account deletion: withdraw every listing the user still has on the market. Returns how many. */
export async function withdrawAuthorListings(authorUserId: string): Promise<number> {
  const listings = await SkillListing.find(
    { authorUserId, deletedAt: null, status: { $nin: ['withdrawn', 'delisted'] } },
    { _id: 1 }
  ).lean();
  let withdrawn = 0;
  for (const { _id } of listings) {
    if (await withdrawListing(String(_id))) withdrawn += 1;
  }
  return withdrawn;
}

const HOUR_MS = 60 * 60 * 1000;

// The Request augmentation that declares `user` lives in apps/client/global.d.ts, outside this
// package's compilation.
const isAdminRequest = (req: object): boolean => !!(req as { user?: { isAdmin?: boolean } }).user?.isAdmin;

/**
 * Anti-spam for every scan-triggering route (publish, resubmit, rescan): a burst cap plus the
 * admin-set daily cap. Each scan may cost an LLM call, so this also bounds classifier spend.
 * Super-admins are exempt (seeding, moderation tests).
 */
export const submitRateLimits = () => [
  rateLimit({
    limit: req => (isAdminRequest(req) ? Infinity : 10),
    windowMs: HOUR_MS,
    bucket: 'skill-market-submit',
  }),
  rateLimit({
    limit: async req => (isAdminRequest(req) ? Infinity : (await loadMarketSettings()).dailySubmitLimit),
    windowMs: 24 * HOUR_MS,
    bucket: 'skill-market-submit-daily',
  }),
];

/** Imports per user, shared by the SPA import route and its v1 twin so they draw on one allowance. */
export const importRateLimit = () => rateLimit({ limit: 60, windowMs: HOUR_MS, bucket: 'skill-market-import' });

/**
 * Applies `submitRateLimits` from inside a handler, for a route that scans only on some requests (a
 * global-skill save that changes content). Shares the publish buckets, so saves and submissions
 * draw on one allowance. Throws the limiter's TooManyRequestsError when a cap is hit.
 */
export async function enforceSubmitRateLimits(
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1]
): Promise<void> {
  for (const limiter of submitRateLimits()) {
    const error = await new Promise<unknown>((resolve, reject) => {
      Promise.resolve(limiter(req, res, resolve)).catch(reject);
    });
    if (error) throw error;
  }
}
