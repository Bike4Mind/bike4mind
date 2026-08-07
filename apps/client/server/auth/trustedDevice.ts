import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { TRUSTED_DEVICE_TTL_MS, trustedDeviceRepository, type ITrustedDeviceDocument } from '@bike4mind/database';
import { getClientIp } from '@server/utils/ip';

// "Remember this device": lets a returning user skip the SECOND factor (TOTP) for
// TRUSTED_DEVICE_TTL_MS. The emailed OTC is still required on every fresh login -
// this cookie is a factor-skip voucher, never a standalone credential, so a stolen
// cookie alone cannot reach the account.
//
// The cookie value is `<deviceId>.<secret>`; the server stores only SHA-256(secret)
// (see TrustedDeviceModel). Grant lives in /api/auth/mfa/verify, consumption in
// /api/otc/verify, revocation in /api/auth/trusted-devices.

export const TRUSTED_DEVICE_COOKIE = 'b4m_td';

/**
 * Only what the trust check actually reads. Structural rather than express's `Request`
 * so these helpers are callable from handlers typed with narrower route generics.
 */
type TrustedDeviceRequest = Pick<Request, 'headers'>;

// getClientIp probes socket/ip defensively and only ever reads, so the widening is safe.
const clientIp = (req: TrustedDeviceRequest): string | undefined => getClientIp(req as Request) || undefined;

/** Matches the model's `<id>.<secret>` split; ids are hex ObjectIds, secrets base64url. */
const COOKIE_VALUE = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{20,128})$/;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Minimal cookie-header parser (same pattern as publishGateToken). */
function cookieFromHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function parseCookie(req: TrustedDeviceRequest): { id: string; secret: string } | null {
  const raw = cookieFromHeader(req.headers.cookie, TRUSTED_DEVICE_COOKIE);
  if (!raw) return null;
  const match = COOKIE_VALUE.exec(raw);
  return match ? { id: match[1], secret: match[2] } : null;
}

/** Append rather than overwrite - a string Set-Cookie replaces the whole header. */
function appendCookie(res: Response, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  const next = existing
    ? Array.isArray(existing)
      ? [...existing.map(String), cookie]
      : [String(existing), cookie]
    : cookie;
  res.setHeader('Set-Cookie', next);
}

function setCookie(res: Response, value: string, maxAgeSeconds: number): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(
    res,
    `${TRUSTED_DEVICE_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`
  );
}

export function clearTrustedDeviceCookie(res: Response): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${TRUSTED_DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
}

/**
 * Best-effort device description for the management UI. Purely cosmetic - the trust
 * decision never reads it, so a spoofed user agent buys an attacker nothing.
 */
export function describeDevice(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Firefox\//.test(userAgent)
          ? 'Firefox'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /(iPhone|iPad|iPod)/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

/**
 * Grant (or extend) trust for the device making this request and set the cookie.
 *
 * If the request already carries a live trust for THIS user the existing record is
 * re-used and its window slid forward, so re-checking the box on every login does not
 * accumulate a row per sign-in. Returns the device record.
 */
export async function grantTrustedDevice(
  req: TrustedDeviceRequest,
  res: Response,
  userId: string
): Promise<ITrustedDeviceDocument | null> {
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
  const maxAgeSeconds = Math.floor(TRUSTED_DEVICE_TTL_MS / 1000);
  const ip = clientIp(req);

  const presented = parseCookie(req);
  if (presented) {
    const existing = await trustedDeviceRepository.findValidForUser(presented.id, userId);
    if (existing && secretMatches(presented.secret, existing.tokenHash)) {
      await trustedDeviceRepository.extend(existing.id, expiresAt, ip);
      setCookie(res, `${presented.id}.${presented.secret}`, maxAgeSeconds);
      return existing;
    }
  }

  const secret = randomBytes(32).toString('base64url');
  const userAgent = (req.headers['user-agent'] as string) || undefined;
  const device = await trustedDeviceRepository.create({
    userId,
    tokenHash: sha256(secret),
    label: describeDevice(userAgent),
    userAgent,
    createdIp: ip,
    expiresAt,
  });
  setCookie(res, `${device.id}.${secret}`, maxAgeSeconds);
  return device;
}

function secretMatches(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(sha256(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/**
 * The live trust for `userId` carried by this request, or null. Records the use but
 * does NOT extend the window - the 30 days run from the grant, so a device always
 * re-proves the second factor eventually. Never throws: any failure means "not
 * trusted", so a database blip degrades to the normal MFA challenge, not to a bypass.
 */
export async function consumeTrustedDevice(
  req: TrustedDeviceRequest,
  userId: string
): Promise<ITrustedDeviceDocument | null> {
  const device = await identifyTrustedDevice(req, userId);
  if (device) {
    try {
      await trustedDeviceRepository.touch(device.id, clientIp(req));
    } catch {
      // Bookkeeping only - the trust is already proven, so a failed write must not
      // downgrade a valid skip into a challenge.
    }
  }
  return device;
}

/**
 * Same check as `consumeTrustedDevice` but with no write. For callers that only need
 * to know WHICH device this is (flagging "this device" in the list, deciding whether a
 * revoke should clear the cookie) - marking those reads as a "use" would make the
 * lastUsedAt column read as today every time the user opened their settings.
 */
export async function identifyTrustedDevice(
  req: TrustedDeviceRequest,
  userId: string
): Promise<ITrustedDeviceDocument | null> {
  try {
    const presented = parseCookie(req);
    if (!presented) return null;
    const device = await trustedDeviceRepository.findValidForUser(presented.id, userId);
    if (!device || !secretMatches(presented.secret, device.tokenHash)) return null;
    return device;
  } catch {
    return null;
  }
}
