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
 * The per-email caps are the anti-email-bombing and brute-force controls, so they are tight. The
 * per-IP caps only bound a single source, so they are sized for a shared office or campus NAT where
 * many distinct people sign in from one address: the short window counts distinct emails per IP
 * (repeat sends to one address are already capped per email) and the blunt total plus daily caps
 * keep one IP bounded no matter what.
 */
export const OTC_LIMITS = {
  send: {
    cooldownMs: 30 * 1000,
    perEmail: { limit: 5, windowMs: 15 * MINUTE_MS },
    perEmailDaily: { limit: 15, windowMs: DAY_MS },
    perIpDistinctEmails: { limit: 15, windowMs: 15 * MINUTE_MS },
    perIpTotal: { limit: 40, windowMs: 15 * MINUTE_MS },
    perIpDaily: { limit: 200, windowMs: DAY_MS },
  },
  verify: {
    perEmail: { limit: 10, windowMs: 15 * MINUTE_MS },
    perIp: { limit: 60, windowMs: 15 * MINUTE_MS },
  },
} as const;

/** Lowercased, trimmed email from a request body, or undefined when it is not a string. */
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

export const emailSubject = (req: Parameters<RequestHandler>[0]): string | undefined => {
  const email = normalizeOtcEmail(req.body?.email);
  return email ? otcEmailKey(otcLimitMailbox(email)) : undefined;
};

export const ipSubject = (req: Parameters<RequestHandler>[0]): string => getClientIp(req);

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
  const ip = getClientIp(req);
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
