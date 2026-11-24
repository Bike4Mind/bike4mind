import { randomInt } from 'crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { inboxAliasKey, requireEnv, settingsMap } from '@bike4mind/common';
import { adminSettingsRepository, User, withTransaction } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import {
  appendSetCookie,
  readCookie,
  secureAttribute,
  sessionCookieName,
  type CookieResponse,
} from '@bike4mind/server-utils/auth/refreshCookie';
import { emitProductEvent, HOST_PRODUCT_ID } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { isBlockedInviter, type RewardParty } from '@bike4mind/server-utils/referrals/firstAnswerReward';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { WEBSITE_URL } from '@client/config/general';

/**
 * Share links: every user can hand out `/r/<code>`. A visit stores the code in a first-party cookie
 * (pages/api/referrals/visit/[code].ts), and the OTC and OAuth signup paths call creditShareLinkSignup,
 * which sets referredByUserId. Every referral reward keys off that field
 * (packages/server-utils/src/referrals/), so a credited link signup earns what an invite signup earns.
 */

// Written under sessionCookieName's `__Host-` prefix in production, so only this host sets or reads it.
const REFERRAL_COOKIE_BASE = 'b4m_ref';
export const referralCookieName = (): string => sessionCookieName(REFERRAL_COOKIE_BASE);
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const CAP_WINDOW_DAYS = 30;

// No 0/o, 1/l/i: the code is read aloud and retyped from screenshots.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);
const MINT_ATTEMPTS = 5;

export const SHARE_LINK_OUTCOMES = [
  'credited',
  'disabled',
  'unknown_code',
  'already_referred',
  'referrer_ineligible',
  'own_account',
  'shared_network',
  'monthly_cap',
] as const;
export type ShareLinkOutcome = (typeof SHARE_LINK_OUTCOMES)[number];

const REFERRER_FIELDS =
  'email emailVerified authProviders.strategy signupMeta.ip loginRecords.ip isSynthetic deletedAt isBanned disputePending moderation.status signupGrant.blocked signupGrant.unlockForfeited';

type Referrer = RewardParty & {
  _id: { toString(): string };
  email?: string | null;
  emailVerified?: boolean;
  authProviders?: Array<{ strategy?: string }>;
  signupMeta?: { ip?: string | null } | null;
  loginRecords?: Array<{ ip?: string | null }>;
};

type NewAccount = {
  email?: string | null;
  signupMeta?: { ip?: string | null } | null;
  referredByUserId?: unknown;
};

/** The canonical form of a code from a URL or cookie, or null when it cannot be one. */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}

function mintCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** GET /api/referrals/link */
export interface ReferralLinkResponse {
  code: string;
  url: string;
}

export function referralLinkUrl(code: string): string {
  return `${requireEnv('APP_URL', process.env.APP_URL).replace(/\/+$/, '')}/r/${code}`;
}

/** The links on a published page that carry its author's share link (pages/api/publish/serve/[...path].ts). */
export const SHARE_LINK_VIA = ['embed-badge', 'share-bar'] as const;
export type ShareLinkVia = (typeof SHARE_LINK_VIA)[number];

/** The marketing site, tagged with the publish campaign, for a published-page link; null when no site is configured. */
export function publishMarketingUrl(via: ShareLinkVia): string | null {
  return WEBSITE_URL
    ? `${WEBSITE_URL.replace(/\/+$/, '')}/?utm_source=shared-artifact&utm_medium=${via}&utm_campaign=publish`
    : null;
}

/** The published-page link a visit's `via` query names; undefined for anything else, a repeated `via` included. */
export function parseShareLinkVia(via: unknown): ShareLinkVia | undefined {
  return SHARE_LINK_VIA.find(value => value === via);
}

/** Where a share-link visit goes: a published-page link keeps its marketing landing, anything else signs up. */
export function shareLinkDestination(via: unknown): string {
  const known = parseShareLinkVia(via);
  return (known && publishMarketingUrl(known)) || '/register';
}

/** The user's share-link code, minted on first use. Idempotent: concurrent first calls return one code. */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const current = await User.findById(userId).select('referralCode').lean<{ referralCode?: string | null }>();
    if (!current) throw new Error('User not found');
    if (current.referralCode) return current.referralCode;
    try {
      // The filter keeps a concurrent mint from being overwritten; the next pass reads whichever won.
      await User.updateOne(
        { _id: userId, referralCode: { $not: { $type: 'string' } } },
        { $set: { referralCode: mintCode() } },
        { runValidators: true }
      );
    } catch (error) {
      // Another account already holds this code; draw again.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  // The final attempt has no next loop iteration to read a successful or concurrent winner.
  const winner = await User.findById(userId).select('referralCode').lean<{ referralCode?: string | null }>();
  if (!winner) throw new Error('User not found');
  if (winner.referralCode) return winner.referralCode;
  throw new Error('Could not mint a unique referral code');
}

// Lax, not Strict: the OAuth provider returns the browser by a cross-site top-level GET, and the
// callback has to read this cookie on that request.
export function setReferralCookie(res: CookieResponse, code: string): void {
  appendSetCookie(
    res,
    `${referralCookieName()}=${code}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secureAttribute()}`
  );
}

export function clearReferralCookie(res: CookieResponse): void {
  appendSetCookie(res, `${referralCookieName()}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureAttribute()}`);
}

export const readReferralCookie = (req: Pick<Request, 'headers'>): string | null =>
  normalizeReferralCode(readCookie(req, referralCookieName()));

const sameInbox = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a && b && inboxAliasKey(a) === inboxAliasKey(b));

// Compared against the IPs the referrer signed up and logged in from; loginRecords is capped when written.
function sharesReferrerNetwork(account: NewAccount, referrer: Referrer): boolean {
  const ip = account.signupMeta?.ip;
  if (!ip) return false;
  if (referrer.signupMeta?.ip === ip) return true;
  return (referrer.loginRecords ?? []).some(record => record.ip === ip);
}

async function decide(code: string, userId: string, now: Date): Promise<ShareLinkOutcome> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['ReferralLinkSignupsPerMonth'], skipCache: true }
  );
  const cap = getSettingsValue(
    'ReferralLinkSignupsPerMonth',
    settings,
    settingsMap.ReferralLinkSignupsPerMonth.schema.parse(undefined)
  );
  if (!(cap > 0)) return 'disabled';

  return withTransaction<ShareLinkOutcome>(async session => {
    const referrer = await User.findOne({ referralCode: code })
      .select(REFERRER_FIELDS)
      .session(session)
      .lean<Referrer>();
    const account = await User.findById(userId)
      .select('email signupMeta.ip referredByUserId')
      .session(session)
      .lean<NewAccount>();
    if (!referrer || !account) return 'unknown_code';
    const referrerId = referrer._id.toString();
    if (referrerId === userId) return 'own_account';
    if (account.referredByUserId) return 'already_referred';

    // The bar the email-invite flow sets for senders (pages/api/reg-invites/refer.ts), plus the reward gate.
    const referrerVerified = referrer.emailVerified === true || (referrer.authProviders?.length ?? 0) > 0;
    if (!referrerVerified || isBlockedInviter(referrer)) return 'referrer_ineligible';
    if (sameInbox(account.email, referrer.email)) return 'own_account';
    if (sharesReferrerNetwork(account, referrer)) return 'shared_network';

    // Serialize the rolling count and attribution across different new-account documents.
    // A retry re-reads eligibility and the count; the revision write must actually change the parent.
    const locked = await User.updateOne(
      { _id: referrerId, 'deletion.purgeStartedAt': null },
      { $inc: { __v: 1 } },
      { session, timestamps: false, runValidators: true }
    );
    if (locked.matchedCount !== 1) return 'referrer_ineligible';
    const recent = await User.countDocuments(
      {
        referredByUserId: referrerId,
        referredViaLinkAt: { $gte: new Date(now.getTime() - CAP_WINDOW_DAYS * DAY_MS) },
      },
      { session }
    );
    if (recent >= cap) return 'monthly_cap';

    const write = await User.updateOne(
      { _id: userId, referredByUserId: null },
      { $set: { referredByUserId: referrerId, referredViaLinkAt: now } },
      { runValidators: true, session }
    );
    return write.modifiedCount === 1 ? 'credited' : 'already_referred';
  });
}

/**
 * The author's share link for a link on their published page, so a signup that starts there credits them.
 * Mints the author's code on first need when they may have one. Null when they may not, or on any failure:
 * the page then links where it did before. Never throws.
 */
export async function publishedAuthorShareLink(
  ownerId: string,
  owner: { referralCode: string | null; canRefer: boolean },
  via: ShareLinkVia
): Promise<string | null> {
  try {
    const code = owner.referralCode ?? (owner.canRefer ? await getOrCreateReferralCode(ownerId) : null);
    return code ? `${referralLinkUrl(code)}?via=${via}` : null;
  } catch (error) {
    Logger.warn('[referral] published page links without a share link', {
      ownerId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}

/**
 * Credits a brand-new account to the owner of the share link in its browser's referral cookie. Call
 * after the account and its signupMeta are stored. An invite referral set at creation wins. Returns
 * null when the browser carries no code. Never throws: the signup has already happened.
 */
export async function creditShareLinkSignup(input: {
  req: Pick<Request, 'headers'>;
  res: CookieResponse;
  userId: string;
  method: string;
  /** Test personas are still credited but stay out of product analytics. */
  isSynthetic: boolean;
  now?: Date;
}): Promise<ShareLinkOutcome | null> {
  const code = readReferralCookie(input.req);
  if (!code) return null;
  let outcome: ShareLinkOutcome;
  try {
    // This completed signup consumes its valid cookie even if attribution cannot be stored.
    clearReferralCookie(input.res);
    outcome = await decide(code, input.userId, input.now ?? new Date());
  } catch (error) {
    Logger.warn('[referral] share link signup was not credited', {
      userId: input.userId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
  if (input.isSynthetic) return outcome;
  await emitProductEvent({
    productId: HOST_PRODUCT_ID,
    event: 'referral_link_signup',
    userId: input.userId,
    metadata: { outcome, method: input.method },
    metadataFields: {
      outcome: z.enum(SHARE_LINK_OUTCOMES),
      method: z.string().regex(/^[a-z]{2,16}$/),
    },
  }).catch(() => undefined);
  return outcome;
}
