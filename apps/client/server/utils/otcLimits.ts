import { createHash } from 'crypto';
import { adminSettingsRepository, cacheRepository, userRepository } from '@bike4mind/database';
import { personalEmailProviders, type SettingKey } from '@bike4mind/common';
import { TooManyRequestsError, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import type { RequestHandler } from 'express';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { deliveryMailbox } from './deliveryMailbox';
import { ipv6Slash64 } from './ipv6Slash64';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

interface OtcWindow {
  limit: number;
  windowMs: number;
  /** The admin setting that may lower `limit` (see otcLimitOf). */
  setting: SettingKey;
}

/**
 * Every one-time-code limit lives here.
 *
 * Nothing proves who is asking for a code, so any per-email cap a stranger can fill is a lever to
 * lock the owner out. The send caps that refuse for long are therefore keyed per (inbox, source IP):
 * one source can neither bomb an inbox nor spend the owner's allowance. The inbox-wide ceiling stops
 * a many-source bomb but has only a short window, so a lockout bought with it lasts at most one
 * window after the attacker stops paying. There is deliberately no inbox-wide daily refusal.
 *
 * The wrong-guess budget is keyed per (address, source) for the same reason: no other source's
 * guesses can refuse the owner's verify. Guessing stays bounded across sources because every guess
 * needs a live token, the inbox-wide send ceiling issues at most 15 per 15-minute window (1,440 a
 * day), and each token takes 5 guesses: at most 7,200 guesses a day (~2.6% a year) against the 10^8
 * 8-digit codes, and only for an attacker who also mails the owner 1,440 codes a day. One source
 * alone gets 10 guesses per 15 minutes (960 a day).
 *
 * The per-IP caps only bound a single source, so they are sized for a shared office or campus NAT
 * where many distinct people sign in from one address: the short window counts distinct emails per
 * IP and the blunt total plus daily caps keep one IP bounded no matter what.
 *
 * The per-domain caps stop one abuser registering accounts on fresh aliases or subdomains of a
 * catch-all burner domain from many sources. They count new accounts, charged only after the code
 * is proven, never sends or sign-ins: a stranger cannot spend a domain's budget without controlling
 * one of its inboxes, so it is no lever against anyone else, and a refusal tells only an inbox owner
 * anything. Personal mail providers and established domains (see isEstablishedOtcDomain) are exempt.
 *
 * Each window's limit can be lowered, never raised, by its admin setting during an incident. Every
 * setting's `max` in settingsMap (b4m-core/common/src/schemas/settings.ts) must equal the limit here.
 */
export const OTC_LIMITS = {
  send: {
    cooldownMs: 30 * 1000,
    perEmailPerIp: { limit: 5, windowMs: 15 * MINUTE_MS, setting: 'otcLimitSendPerEmailPerIp' },
    perEmailPerIpDaily: { limit: 15, windowMs: DAY_MS, setting: 'otcLimitSendPerEmailPerIpDaily' },
    perEmail: { limit: 15, windowMs: 15 * MINUTE_MS, setting: 'otcLimitSendPerEmail' },
    perIpDistinctEmails: { limit: 15, windowMs: 15 * MINUTE_MS, setting: 'otcLimitSendPerIpDistinctEmails' },
    perIpTotal: { limit: 40, windowMs: 15 * MINUTE_MS, setting: 'otcLimitSendPerIpTotal' },
    perIpDaily: { limit: 200, windowMs: DAY_MS, setting: 'otcLimitSendPerIpDaily' },
  },
  verify: {
    perEmailPerIp: { limit: 10, windowMs: 15 * MINUTE_MS, setting: 'otcLimitVerifyPerEmailPerIp' },
    perIp: { limit: 60, windowMs: 15 * MINUTE_MS, setting: 'otcLimitVerifyPerIp' },
  },
  register: {
    perDomainHourly: { limit: 5, windowMs: HOUR_MS, setting: 'otcLimitRegisterPerDomainHourly' },
    perDomainDaily: { limit: 20, windowMs: DAY_MS, setting: 'otcLimitRegisterPerDomainDaily' },
  },
} as const satisfies {
  send: Record<string, OtcWindow | number>;
  verify: Record<string, OtcWindow>;
  register: Record<string, OtcWindow>;
};

/** The window's limit as an admin has lowered it, else the built-in. A setting can never raise it. */
export async function otcLimitOf({ limit, setting }: OtcWindow): Promise<number> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const lowered = getSettingsValue(setting, settings);
  return typeof lowered === 'number' && lowered > 0 ? Math.min(limit, lowered) : limit;
}

export function normalizeOtcEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.toLowerCase().trim();
  return email || undefined;
}

/** Hashed so cache keys never carry a raw email address. */
export function otcEmailKey(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 32);
}

function retryAfterSeconds(expiresAt: Date, windowMs: number): number {
  const timeLeftMs = expiresAt.getTime() - Date.now();
  return Math.max(1, Math.ceil((timeLeftMs > 0 ? timeLeftMs : windowMs) / 1000));
}

interface CounterOptions {
  bucket: string;
  window: OtcWindow;
  /** Counter subject for this request; undefined skips the check. */
  subject: (req: Parameters<RequestHandler>[0]) => string | undefined;
}

/** Fixed-window counter keyed on a request-derived subject that answers 429 with Retry-After. */
export const otcCounterLimit =
  ({ bucket, window, subject }: CounterOptions): RequestHandler =>
  async (req, res, next) => {
    // isE2EEnabled is hard-false on production; CI draws every send from one shared IP and address.
    if (isE2EEnabled()) return next();
    const resolved = subject(req);
    if (!resolved) return next();

    const { windowMs } = window;
    const { success, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `otc-limit:${bucket}:${resolved}`,
      await otcLimitOf(window),
      windowMs
    );
    if (success) return next();

    const seconds = retryAfterSeconds(expiresAt, windowMs);
    res.setHeader('Retry-After', seconds);
    return next(new TooManyRequestsError(`Rate limit exceeded. Try again in ${seconds} seconds.`));
  };

export const ipSubject = (req: Parameters<RequestHandler>[0]): string => otcIpBucket(getClientIp(req));

/**
 * The per-IP limit subject. IPv6 is bucketed by /64, the smallest prefix a single subscriber is
 * usually assigned, so one holder cannot rotate through addresses for a fresh budget. IPv4 and
 * IPv4-mapped IPv6 are keyed on the full address. Anything unparseable is returned unchanged.
 */
export function otcIpBucket(ip: string): string {
  if (!ip.includes(':')) return ip;
  const address = ip.split('%')[0];
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mappedV4) return mappedV4[1];
  return ipv6Slash64(address) ?? ip;
}

interface OtcEmailBudget {
  bucket: string;
  window: OtcWindow;
  /**
   * What the budget is keyed on, given the request email and its IP bucket; hashed into the key.
   * Undefined exempts the request from this budget.
   */
  subject: (email: string, ip: string) => string | undefined;
}

const inbox = (email: string) => deliveryMailbox(email);
const inboxFromSource = (email: string, ip: string) => `${deliveryMailbox(email)}|${ip}`;

const PERSONAL_EMAIL_PROVIDERS: ReadonlySet<string> = new Set(personalEmailProviders);

/**
 * The registrable domain (eTLD+1) a domain budget is keyed on, so rotating subdomains of one burner
 * domain shares a single budget. Undefined (exempt) for a personal mail provider or an unparseable
 * domain.
 */
export function otcLimitDomain(email: string): string | undefined {
  const mailbox = deliveryMailbox(email);
  const domain = registrableDomain(mailbox.slice(mailbox.lastIndexOf('@') + 1));
  if (!domain || PERSONAL_EMAIL_PROVIDERS.has(domain)) return undefined;
  return domain;
}

/**
 * Per-email budgets are charged by the handlers, not by middleware, so only real events spend them:
 * a code about to be dispatched for sends (refunded if dispatch throws), a wrong guess against a live token for verifies. Charging every
 * request would let anyone who knows an address lock its owner out with junk traffic, which the
 * per-IP caps bound instead. See OTC_LIMITS for why the send budgets are keyed per source.
 */
export const OTC_SEND_EMAIL_BUDGETS: readonly OtcEmailBudget[] = [
  { bucket: 'send-email-ip', window: OTC_LIMITS.send.perEmailPerIp, subject: inboxFromSource },
  { bucket: 'send-email-ip-daily', window: OTC_LIMITS.send.perEmailPerIpDaily, subject: inboxFromSource },
  { bucket: 'send-email', window: OTC_LIMITS.send.perEmail, subject: inbox },
];
/** New accounts per email domain; see reserveOtcRegistrationDomainBudget. */
export const OTC_REGISTER_DOMAIN_BUDGETS: readonly OtcEmailBudget[] = [
  { bucket: 'register-domain-hourly', window: OTC_LIMITS.register.perDomainHourly, subject: otcLimitDomain },
  { bucket: 'register-domain-daily', window: OTC_LIMITS.register.perDomainDaily, subject: otcLimitDomain },
];
// Keyed on the exact token address plus the verifying source, not the folded inbox: each alias has
// its own nonce and account, so folding adds no brute-force protection, and a guess from one source
// must never spend the owner's budget (see OTC_LIMITS).
// Safe only because sendOTC's ASCII-only email validation issues no token for an address that
// userRepository.findByEmail's strength-2 collation would match to another account (zero-width or
// fullwidth variants); a looser validator would give each such variant its own verify budget.
export const OTC_VERIFY_EMAIL_BUDGETS: readonly OtcEmailBudget[] = [
  { bucket: 'verify-email-ip', window: OTC_LIMITS.verify.perEmailPerIp, subject: (email, ip) => `${email}|${ip}` },
];

/** The budget's counter key for this request, or undefined when the request is exempt from it. */
function budgetKey({ bucket, subject }: OtcEmailBudget, email: string, ip: string): string | undefined {
  const resolved = subject(email, ip);
  return resolved === undefined ? undefined : `otc-limit:${bucket}:${otcEmailKey(resolved)}`;
}

/**
 * Retry-After seconds when any of the email's budgets is spent, else undefined. Spends nothing.
 * `ip` is the caller's otcIpBucket (see ipSubject).
 */
export async function otcEmailBudgetRetryAfter(
  email: string,
  ip: string,
  budgets: readonly OtcEmailBudget[]
): Promise<number | undefined> {
  if (isE2EEnabled()) return undefined;
  for (const budget of budgets) {
    const key = budgetKey(budget, email, ip);
    if (!key) continue;
    const { windowMs } = budget.window;
    const limit = await otcLimitOf(budget.window);
    const { count, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(key, 0, limit, windowMs);
    if (count >= limit) return retryAfterSeconds(expiresAt, windowMs);
  }
  return undefined;
}

/** Spends one unit of each of the email's budgets. */
export async function chargeOtcEmailBudget(
  email: string,
  ip: string,
  budgets: readonly OtcEmailBudget[]
): Promise<void> {
  if (isE2EEnabled()) return;
  for (const budget of budgets) {
    const key = budgetKey(budget, email, ip);
    if (!key) continue;
    await cacheRepository.tryIncrementWithinLimitFixedWindow(
      key,
      await otcLimitOf(budget.window),
      budget.window.windowMs
    );
  }
}

/**
 * Spends one unit of every budget or none: on the first full budget the units already taken are
 * handed back. Returns the Retry-After seconds when refused, else a refund for a failed dispatch.
 */
export async function reserveOtcEmailBudget(
  email: string,
  ip: string,
  budgets: readonly OtcEmailBudget[]
): Promise<{ retryAfter: number } | { refund: () => Promise<void> }> {
  const taken: { key: string; expiresAt: Date }[] = [];
  // A unit taken in a window that has since rolled over is already gone; decrementing the new
  // window would hand back another caller's unit.
  const refund = async () => {
    const now = Date.now();
    for (const { key, expiresAt } of taken) {
      if (expiresAt.getTime() > now) await cacheRepository.decrementCounter(key);
    }
  };
  if (isE2EEnabled()) return { refund };
  for (const budget of budgets) {
    const key = budgetKey(budget, email, ip);
    if (!key) continue;
    const { windowMs } = budget.window;
    const { success, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      key,
      await otcLimitOf(budget.window),
      windowMs
    );
    if (!success) {
      await refund();
      return { retryAfter: retryAfterSeconds(expiresAt, windowMs) };
    }
    taken.push({ key, expiresAt });
  }
  return { refund };
}

/**
 * Caps how many DISTINCT emails one IP may request codes for per window. A first sighting of an
 * (IP, email) pair takes a slot; repeats of a pair never do, so a handful of people behind one NAT
 * are not locked out by each other's retries.
 */
export const otcDistinctEmailsPerIpLimit = (): RequestHandler => async (req, res, next) => {
  if (isE2EEnabled()) return next();
  const email = normalizeOtcEmail(req.body?.email);
  if (!email) return next();

  const { windowMs } = OTC_LIMITS.send.perIpDistinctEmails;
  const limit = await otcLimitOf(OTC_LIMITS.send.perIpDistinctEmails);
  const ip = otcIpBucket(getClientIp(req));
  const pairKey = `otc-limit:ip-email-seen:${ip}:${otcEmailKey(deliveryMailbox(email))}`;

  // Slot before marker: a marker only ever follows a granted slot, so a concurrent duplicate of a
  // refused pair cannot ride its marker past the cap. Racing first sightings may both take a slot.
  const seen = await cacheRepository.tryAddWithinLimitFixedWindow(pairKey, 0, 1, windowMs);
  if (seen.count >= 1) return next();

  const slot = await cacheRepository.tryIncrementWithinLimitFixedWindow(`otc-limit:ip-distinct:${ip}`, limit, windowMs);
  if (slot.success) {
    await cacheRepository.tryIncrementWithinLimitFixedWindow(pairKey, 1, windowMs);
    return next();
  }

  const seconds = retryAfterSeconds(slot.expiresAt, windowMs);
  res.setHeader('Retry-After', seconds);
  return next(new TooManyRequestsError(`Rate limit exceeded. Try again in ${seconds} seconds.`));
};

/** How long an account on a domain must have held a verified email before the domain is established. */
export const OTC_ESTABLISHED_DOMAIN_MIN_AGE_MS = 7 * DAY_MS;
const ESTABLISHED_DOMAIN_CACHE_MS = DAY_MS;
const UNESTABLISHED_DOMAIN_CACHE_MS = HOUR_MS;

/**
 * Whether a live, unbanned account on `domain` verified its email at least
 * OTC_ESTABLISHED_DOMAIN_MIN_AGE_MS ago. The age keeps an abuser from lifting their own domain's
 * budget by verifying one alias: they would have to hold it for a week first. Cached both ways
 * because the lookup is an unindexed scan.
 */
export async function isEstablishedOtcDomain(domain: string): Promise<boolean> {
  const key = `otc-domain-established:${otcEmailKey(domain)}`;
  const cached = await cacheRepository.findByKey(key);
  if (typeof cached?.result === 'boolean') return cached.result;

  const now = Date.now();
  const established = await userRepository.existsVerifiedUserOnEmailDomain(
    domain,
    new Date(now - OTC_ESTABLISHED_DOMAIN_MIN_AGE_MS)
  );
  const ttlMs = established ? ESTABLISHED_DOMAIN_CACHE_MS : UNESTABLISHED_DOMAIN_CACHE_MS;
  await cacheRepository.createOrUpdate({ key, result: established, expiresAt: new Date(now + ttlMs) });
  return established;
}

const noRefund = async () => undefined;

/**
 * Spends one new-account unit of the email's domain budgets, for a registration whose code is
 * already proven. An established domain is never refused; it is looked up only once the budget
 * would refuse, so ordinary signups never scan users. Returns the Retry-After seconds when refused,
 * else a refund for a registration that then fails.
 */
export async function reserveOtcRegistrationDomainBudget(
  email: string
): Promise<{ retryAfter: number } | { refund: () => Promise<void> }> {
  const reservation = await reserveOtcEmailBudget(email, '', OTC_REGISTER_DOMAIN_BUDGETS);
  if ('refund' in reservation) return reservation;
  const domain = otcLimitDomain(email);
  return domain && (await isEstablishedOtcDomain(domain)) ? { refund: noRefund } : reservation;
}
