import { createHash } from 'crypto';
import { isBlockedPhone, normalizeE164, type NoCardUnlockRefusal, type NoCardUnlockSettings } from '@bike4mind/common';
import {
  adminSettingsRepository,
  cacheRepository,
  creditTransactionRepository,
  creditLotRepository,
  phoneUnlockClaimRepository,
  userRepository,
} from '@bike4mind/database';
import { getClientIp, getClientNetwork, type ClientIpRequest } from '@bike4mind/server-utils/utils/ip';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';
import { otcIpBucket } from '@server/utils/otcLimits';
import {
  TwilioApiError,
  checkVerificationCode,
  isTwilioUnavailable,
  lookupPhone,
  sendVerificationCode,
  twilioCredentials,
} from './twilio';

const { noCardUnlockEligibility, phoneValidator } = userService;
type NoCardUnlockValidator = userService.NoCardUnlockValidator;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Twilio Verify codes expire after 10 minutes by default; the binding outlives them by nothing. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Send attempts per day. Farms rotate numbers cheaply, so the ceilings sit on what they cannot rotate
 * as cheaply: the account and source IP (fixed here), and the ASN and the number's country (admin
 * settings, since a fixed value would refuse real users on a large carrier). The account, IP and ASN
 * caps run before any check that reveals something and before any paid call; the country cap needs the
 * paid Lookup to know the country.
 */
export const PHONE_UNLOCK_SEND_LIMITS = {
  perUser: { limit: 3, windowMs: DAY_MS },
  perIp: { limit: 5, windowMs: DAY_MS },
} as const;

/** Twilio caps checks per verification too; this bounds code guessing across re-sends. */
export const PHONE_UNLOCK_VERIFY_LIMIT = { limit: 10, windowMs: HOUR_MS } as const;

/** Only a mobile line passes; VoIP (fixed or not), landline, toll-free, pager and unknown are refused. */
const ACCEPTED_LINE_TYPES = new Set(['mobile']);

const pendingKey = (userId: string) => `phone-unlock:pending:${userId}`;

export const hashPhone = (phone: string) => createHash('sha256').update(phone).digest('hex');

async function withinLimit(key: string, { limit, windowMs }: { limit: number; windowMs: number }): Promise<boolean> {
  const { success } = await cacheRepository.tryIncrementWithinLimitFixedWindow(key, limit, windowMs);
  return success;
}

async function getPendingPhone(userId: string): Promise<string | null> {
  const entry = await cacheRepository.findByKey(pendingKey(userId));
  if (!entry || entry.expiresAt.getTime() <= Date.now()) return null;
  const phone = (entry.result as { phone?: unknown } | null)?.phone;
  return typeof phone === 'string' ? phone : null;
}

async function claimedByOther(phone: string, userId: string): Promise<boolean> {
  const owner = await phoneUnlockClaimRepository.ownerOf(hashPhone(phone));
  return owner !== null && owner !== userId;
}

/** `sentTo` is the number the code went to, which can differ from the typed one (see the canonical re-check). */
export type PhoneUnlockStartResponse = { sent: true; sentTo: string } | { sent: false; refusal: NoCardUnlockRefusal };

const refuse = (refusal: NoCardUnlockRefusal): PhoneUnlockStartResponse => ({ sent: false, refusal });

async function bindPending(userId: string, phone: string): Promise<PhoneUnlockStartResponse> {
  await cacheRepository.createOrUpdate({
    key: pendingKey(userId),
    result: { phone },
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  return { sent: true, sentTo: phone };
}

/**
 * Narrowest scope first, stopping at the first refusal: each counter is spent only when every
 * narrower one admitted the request, so one capped account cannot drain its IP's or network's budget.
 */
async function withinSendCaps(userId: string, req: ClientIpRequest, settings: NoCardUnlockSettings): Promise<boolean> {
  const { asn } = getClientNetwork(req);
  const caps: Array<[string, { limit: number; windowMs: number }]> = [
    [`phone-unlock:send:user:${userId}`, PHONE_UNLOCK_SEND_LIMITS.perUser],
    [`phone-unlock:send:ip:${otcIpBucket(getClientIp(req))}`, PHONE_UNLOCK_SEND_LIMITS.perIp],
  ];
  if (asn !== null) caps.push([`phone-unlock:send:asn:${asn}`, { limit: settings.phoneAsnDailyCap, windowMs: DAY_MS }]);
  for (const [key, window] of caps) {
    if (!(await withinLimit(key, window))) return false;
  }
  return true;
}

/**
 * Order: free checks, then the send caps (so the blocklist answer cannot be probed without spending
 * them), then the paid Lookup, then the paid SMS send. A number claimed by another account answers
 * as sent without a send, so start never reveals a claim.
 */
export async function startPhoneUnlock(
  userId: string,
  rawPhone: unknown,
  req: ClientIpRequest
): Promise<PhoneUnlockStartResponse> {
  const phone = normalizeE164(rawPhone);
  if (!phone) return refuse('phone_invalid');

  const settings = await userService.loadNoCardUnlockSettings(adminSettingsRepository);
  const eligibility = await noCardUnlockEligibility(userId, 'phone_verified', {
    db: {
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
      users: userRepository,
    },
    settings,
    signupProtection,
  });
  if (!eligibility.eligible) return refuse(eligibility.refusal);

  const credentials = twilioCredentials();
  if (!credentials) return refuse('disabled');

  if (!(await withinSendCaps(userId, req, settings))) return refuse('phone_rate_limited');

  if (isBlockedPhone(phone, settings.phoneBlockedPrefixes)) return refuse('phone_blocked');
  // A number another account claimed answers as sent but sends nothing, so start cannot be used to learn
  // whether a number is registered; verify then fails as a wrong code. Possession is proven before any reveal.
  if (await claimedByOther(phone, userId)) return bindPending(userId, phone);

  let canonical: string;
  try {
    const lookup = await lookupPhone(credentials, phone);
    if (!lookup.valid) return refuse('phone_invalid');
    if (!lookup.lineType || !ACCEPTED_LINE_TYPES.has(lookup.lineType)) return refuse('phone_line_type');
    // The typed string is not the identity: a kept trunk 0 or similar variant reaches the same line.
    canonical = normalizeE164(lookup.phoneNumber) ?? phone;
    if (canonical !== phone) {
      if (isBlockedPhone(canonical, settings.phoneBlockedPrefixes)) return refuse('phone_blocked');
      if (await claimedByOther(canonical, userId)) return bindPending(userId, canonical);
    }

    const countryCap = { limit: settings.phoneCountryDailyCap, windowMs: DAY_MS };
    if (!(await withinLimit(`phone-unlock:send:country:${lookup.countryCode ?? 'unknown'}`, countryCap))) {
      return refuse('phone_rate_limited');
    }
    await sendVerificationCode(credentials, canonical);
  } catch (error) {
    if (error instanceof TwilioApiError && error.rateLimited) return refuse('phone_rate_limited');
    if (error instanceof TwilioApiError && error.invalidNumber) return refuse('phone_invalid');
    if (error instanceof TwilioApiError && error.blockedNumber) return refuse('phone_blocked');
    if (isTwilioUnavailable(error)) return refuse('phone_unavailable');
    throw error;
  }

  return bindPending(userId, canonical);
}

/** Builds the grant validator for one verify request; `code` is what the user typed. */
export function phoneUnlockValidator(settings: NoCardUnlockSettings, code: string): NoCardUnlockValidator {
  return phoneValidator({
    settings,
    code,
    getPendingPhone,
    checkCode: async (phone, typed) => {
      const credentials = twilioCredentials();
      return credentials ? checkVerificationCode(credentials, phone, typed) : false;
    },
    claimPhone: (phone, userId) => phoneUnlockClaimRepository.claim(hashPhone(phone), userId),
    releasePhone: (phone, userId) => phoneUnlockClaimRepository.release(hashPhone(phone), userId),
  });
}

export async function allowPhoneVerifyAttempt(userId: string): Promise<boolean> {
  return withinLimit(`phone-unlock:verify:user:${userId}`, PHONE_UNLOCK_VERIFY_LIMIT);
}

export async function clearPendingPhone(userId: string): Promise<void> {
  await cacheRepository.deleteByKey(pendingKey(userId));
}
