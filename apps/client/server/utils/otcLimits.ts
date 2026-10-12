import { createHash } from 'crypto';
import { cacheRepository } from '@bike4mind/database';
import { TooManyRequestsError } from '@bike4mind/utils';
import type { RequestHandler } from 'express';
import { isE2EEnabled } from '@server/utils/config';
import { getClientIp } from '@server/utils/ip';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Every one-time-code limit lives here.
 *
 * Nothing proves who is asking for a code, so any per-email cap a stranger can fill is a lever to
 * lock the owner out. The send caps that refuse for long are therefore keyed per (inbox, source IP):
 * one source can neither bomb an inbox nor spend the owner's allowance. The inbox-wide ceiling stops
 * a many-source bomb but has only a short window, so a lockout bought with it lasts at most one
 * window after the attacker stops paying. There is deliberately no inbox-wide daily refusal.
 *
 * The per-IP caps only bound a single source, so they are sized for a shared office or campus NAT
 * where many distinct people sign in from one address: the short window counts distinct emails per
 * IP and the blunt total plus daily caps keep one IP bounded no matter what.
 */
export const OTC_LIMITS = {
  send: {
    cooldownMs: 30 * 1000,
    perEmailPerIp: { limit: 5, windowMs: 15 * MINUTE_MS },
    perEmailPerIpDaily: { limit: 15, windowMs: DAY_MS },
    perEmail: { limit: 15, windowMs: 15 * MINUTE_MS },
    perIpDistinctEmails: { limit: 15, windowMs: 15 * MINUTE_MS },
    perIpTotal: { limit: 40, windowMs: 15 * MINUTE_MS },
    perIpDaily: { limit: 200, windowMs: DAY_MS },
  },
  verify: {
    perEmail: { limit: 10, windowMs: 15 * MINUTE_MS },
    perIp: { limit: 60, windowMs: 15 * MINUTE_MS },
  },
} as const;

export function normalizeOtcEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.toLowerCase().trim();
  return email || undefined;
}

/**
 * The inbox an address delivers to, for limit keys only (never for account identity): a bomber can
 * otherwise rotate plus-tags, Gmail dots, or compatibility-form characters to get a fresh per-email
 * budget for the same inbox. Folding more than strictly needed only makes a limit stricter.
 */
export function otcLimitMailbox(email: string): string {
  const folded = email.normalize('NFKC').toLowerCase();
  const at = folded.lastIndexOf('@');
  if (at <= 0) return folded;
  let local = folded.slice(0, at);
  let domain = folded.slice(at + 1).replace(/\.+$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
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
  limit: number;
  windowMs: number;
  /** Counter subject for this request; undefined skips the check. */
  subject: (req: Parameters<RequestHandler>[0]) => string | undefined;
}

/** Fixed-window counter keyed on a request-derived subject that answers 429 with Retry-After. */
export const otcCounterLimit =
  ({ bucket, limit, windowMs, subject }: CounterOptions): RequestHandler =>
  async (req, res, next) => {
    // isE2EEnabled is hard-false on production; CI draws every send from one shared IP and address.
    if (isE2EEnabled()) return next();
    const resolved = subject(req);
    if (!resolved) return next();

    const { success, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `otc-limit:${bucket}:${resolved}`,
      limit,
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

  const halves = address.split('::');
  if (halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return ip;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (!groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups
    .slice(0, 4)
    .map(g => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

interface OtcEmailBudget {
  bucket: string;
  limit: number;
  windowMs: number;
  /** What the budget is keyed on, given the request email and its IP bucket; hashed into the key. */
  subject: (email: string, ip: string) => string;
}

const inbox = (email: string) => otcLimitMailbox(email);
const inboxFromSource = (email: string, ip: string) => `${otcLimitMailbox(email)}|${ip}`;

/**
 * Per-email budgets are charged by the handlers, not by middleware, so only real events spend them:
 * a code about to be dispatched for sends (refunded if dispatch throws), a wrong guess against a live token for verifies. Charging every
 * request would let anyone who knows an address lock its owner out with junk traffic, which the
 * per-IP caps bound instead. See OTC_LIMITS for why the send budgets are keyed per source.
 */
export const OTC_SEND_EMAIL_BUDGETS: readonly OtcEmailBudget[] = [
  { bucket: 'send-email-ip', ...OTC_LIMITS.send.perEmailPerIp, subject: inboxFromSource },
  { bucket: 'send-email-ip-daily', ...OTC_LIMITS.send.perEmailPerIpDaily, subject: inboxFromSource },
  { bucket: 'send-email', ...OTC_LIMITS.send.perEmail, subject: inbox },
];
// Keyed on the exact token address, not the folded inbox: each alias has its own nonce and account,
// so folding adds no brute-force protection and would let wrong guesses on alias tokens an attacker
// requested lock the owner out of verifying a correct code.
export const OTC_VERIFY_EMAIL_BUDGETS: readonly OtcEmailBudget[] = [
  { bucket: 'verify-email', ...OTC_LIMITS.verify.perEmail, subject: email => email },
];

const budgetKey = ({ bucket, subject }: OtcEmailBudget, email: string, ip: string) =>
  `otc-limit:${bucket}:${otcEmailKey(subject(email, ip))}`;

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
    const { limit, windowMs } = budget;
    const { count, expiresAt } = await cacheRepository.tryAddWithinLimitFixedWindow(
      budgetKey(budget, email, ip),
      0,
      limit,
      windowMs
    );
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
    await cacheRepository.tryIncrementWithinLimitFixedWindow(
      budgetKey(budget, email, ip),
      budget.limit,
      budget.windowMs
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
  const taken: string[] = [];
  const refund = async () => {
    for (const key of taken) await cacheRepository.decrementCounter(key);
  };
  if (isE2EEnabled()) return { refund };
  for (const budget of budgets) {
    const key = budgetKey(budget, email, ip);
    const { success, expiresAt } = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      key,
      budget.limit,
      budget.windowMs
    );
    if (!success) {
      await refund();
      return { retryAfter: retryAfterSeconds(expiresAt, budget.windowMs) };
    }
    taken.push(key);
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

  const { limit, windowMs } = OTC_LIMITS.send.perIpDistinctEmails;
  const ip = otcIpBucket(getClientIp(req));
  const pairKey = `otc-limit:ip-email-seen:${ip}:${otcEmailKey(otcLimitMailbox(email))}`;

  const seen = await cacheRepository.tryIncrementWithinLimitFixedWindow(pairKey, 1, windowMs);
  if (!seen.success) return next();

  const slot = await cacheRepository.tryIncrementWithinLimitFixedWindow(`otc-limit:ip-distinct:${ip}`, limit, windowMs);
  if (slot.success) return next();

  // Release the marker so a retry of the refused email is still counted as a new pair.
  await cacheRepository.deleteByKey(pairKey);
  const seconds = retryAfterSeconds(slot.expiresAt, windowMs);
  res.setHeader('Retry-After', seconds);
  return next(new TooManyRequestsError(`Rate limit exceeded. Try again in ${seconds} seconds.`));
};
