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
import { TwilioApiError, checkVerificationCode, lookupPhone, sendVerificationCode, twilioCredentials } from './twilio';

const { noCardUnlockEligibility, phoneValidator } = userService;
type NoCardUnlockValidator = userService.NoCardUnlockValidator;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Twilio Verify codes expire after 10 minutes by default; the binding outlives them by nothing. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * SMS sends, counted per attempt before any paid Twilio call. Farms rotate numbers cheaply, so the
 * ceilings sit on what they cannot rotate as cheaply: the account, the source network, the ASN,
 * and the number's country.
 */
export const PHONE_UNLOCK_SEND_LIMITS = {
  perUser: { limit: 3, windowMs: DAY_MS },
  perIp: { limit: 5, windowMs: DAY_MS },
  perAsn: { limit: 50, windowMs: DAY_MS },
  perCountry: { limit: 200, windowMs: DAY_MS },
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

export type PhoneUnlockStartResponse = { sent: true } | { sent: false; refusal: NoCardUnlockRefusal };

const refuse = (refusal: NoCardUnlockRefusal): PhoneUnlockStartResponse => ({ sent: false, refusal });

/** Checks everything that costs nothing first, then the paid Lookup, then the paid SMS send. */
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
  if (isBlockedPhone(phone, settings.phoneBlockedPrefixes)) return refuse('phone_blocked');

  const owner = await phoneUnlockClaimRepository.ownerOf(hashPhone(phone));
  if (owner && owner !== userId) return refuse('phone_already_claimed');

  const { asn } = getClientNetwork(req);
  const limits = [
    withinLimit(`phone-unlock:send:user:${userId}`, PHONE_UNLOCK_SEND_LIMITS.perUser),
    withinLimit(`phone-unlock:send:ip:${otcIpBucket(getClientIp(req))}`, PHONE_UNLOCK_SEND_LIMITS.perIp),
    ...(asn === null ? [] : [withinLimit(`phone-unlock:send:asn:${asn}`, PHONE_UNLOCK_SEND_LIMITS.perAsn)]),
  ];
  if ((await Promise.all(limits)).includes(false)) return refuse('phone_rate_limited');

  try {
    const lookup = await lookupPhone(credentials, phone);
    if (!lookup.valid) return refuse('phone_invalid');
    if (!lookup.lineType || !ACCEPTED_LINE_TYPES.has(lookup.lineType)) return refuse('phone_line_type');
    const country = lookup.countryCode ?? 'unknown';
    if (!(await withinLimit(`phone-unlock:send:country:${country}`, PHONE_UNLOCK_SEND_LIMITS.perCountry))) {
      return refuse('phone_rate_limited');
    }
    await sendVerificationCode(credentials, phone);
  } catch (error) {
    if (error instanceof TwilioApiError && error.rateLimited) return refuse('phone_rate_limited');
    if (error instanceof TwilioApiError && error.invalidNumber) return refuse('phone_invalid');
    throw error;
  }

  await cacheRepository.createOrUpdate({
    key: pendingKey(userId),
    result: { phone },
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  return { sent: true };
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
