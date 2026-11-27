import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import {
  TRUSTED_DEVICE_TTL_MS,
  adminSettingsRepository,
  trustedDeviceRepository,
  type ITrustedDeviceDocument,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';

// "Remember this device": lets a returning user skip the SECOND factor (TOTP) for
// TRUSTED_DEVICE_TTL_MS. The emailed OTC is still required on every fresh login -
// this cookie is a factor-skip voucher, never a standalone credential, so a stolen
// cookie alone cannot reach the account.
//
// The cookie value is `<deviceId>.<secret>`; the server stores only SHA-256(secret)
// (see TrustedDeviceModel). Grant lives in /api/auth/mfa/verify, consumption in
// /api/otc/verify, revocation in /api/auth/trusted-devices.
//
// One cookie per account, so remembering account B on a browser does not overwrite
// account A's trust when a user switches between accounts.

const TRUSTED_DEVICE_COOKIE_PREFIX = 'b4m_td_';

/**
 * The single shared cookie used before trust became per-account. Still accepted on read
 * so existing trusts keep working; nothing sets it any more, so it can be dropped once
 * TRUSTED_DEVICE_TTL_MS has passed since the per-account cookie shipped.
 */
export const LEGACY_TRUSTED_DEVICE_COOKIE = 'b4m_td';

/**
 * The `allowTrustedDevices` admin kill switch, read UNCACHED on purpose. The shared
 * settings cache is per-process with a 5-minute TTL and its invalidation only reaches the
 * process that saved the setting, so a cached read would leave every other warm instance
 * honoring trusts for minutes after an admin flips the switch mid-incident. That would
 * contradict the setting's own "ignores existing ones immediately" copy. One indexed
 * single-document read, and only on the login path - not a hot loop.
 */
export async function trustedDevicesAllowed(): Promise<boolean> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['allowTrustedDevices'] }
  );
  return getSettingsValue('allowTrustedDevices', settings) !== false;
}

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

/**
 * Keyed by a hash of the user id so the raw id stays out of the cookie jar. Not an HMAC:
 * the name only routes the lookup (the server still verifies the secret against the
 * user's own record), and a keyed name would orphan every trust on a secret rotation.
 */
export const trustedDeviceCookieName = (userId: string): string =>
  `${TRUSTED_DEVICE_COOKIE_PREFIX}${sha256(userId).slice(0, 16)}`;

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

type PresentedToken = { id: string; secret: string; legacy: boolean };

function parseCookie(req: TrustedDeviceRequest, name: string): { id: string; secret: string } | null {
  const raw = cookieFromHeader(req.headers.cookie, name);
  if (!raw) return null;
  const match = COOKIE_VALUE.exec(raw);
  return match ? { id: match[1], secret: match[2] } : null;
}

/** The user's own cookie first, then the legacy shared one. */
function presentedTokens(req: TrustedDeviceRequest, userId: string): PresentedToken[] {
  const own = parseCookie(req, trustedDeviceCookieName(userId));
  const legacy = parseCookie(req, LEGACY_TRUSTED_DEVICE_COOKIE);
  return [...(own ? [{ ...own, legacy: false }] : []), ...(legacy ? [{ ...legacy, legacy: true }] : [])];
}

type PresentedTrust = { device: ITrustedDeviceDocument; token: PresentedToken };

/** Every presented token that verifies against a live trust of `userId`, own cookie first. */
async function findPresentedTrusts(req: TrustedDeviceRequest, userId: string): Promise<PresentedTrust[]> {
  const trusts: PresentedTrust[] = [];
  for (const token of presentedTokens(req, userId)) {
    const device = await trustedDeviceRepository.findValidForUser(token.id, userId);
    if (device && secretMatches(token.secret, device.tokenHash)) trusts.push({ device, token });
  }
  return trusts;
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

function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`);
}

const expireCookie = (res: Response, name: string): void => setCookie(res, name, '', 0);

/**
 * Drops `userId`'s cookie only, leaving other accounts' trusts on this browser intact.
 * A legacy shared cookie is left alone because it may belong to another account. It is
 * retired on this user's next grant instead (see grantTrustedDevice).
 */
export function clearTrustedDeviceCookie(res: Response, userId: string): void {
  expireCookie(res, trustedDeviceCookieName(userId));
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
 * accumulate a row per sign-in. Sliding here is safe because this whole function sits
 * behind a fresh TOTP pass: the 30 days always run from a proven second factor, never
 * from mere use of the trust (see `trustedDeviceRepository.touch`). Returns the record.
 */
export async function grantTrustedDevice(
  req: TrustedDeviceRequest,
  res: Response,
  userId: string
): Promise<ITrustedDeviceDocument | null> {
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_MS);
  const maxAgeSeconds = Math.floor(TRUSTED_DEVICE_TTL_MS / 1000);
  const ip = clientIp(req);

  const cookieName = trustedDeviceCookieName(userId);

  const presented = await findPresentedTrusts(req, userId);
  const [current] = presented;
  if (current) {
    const { device, token } = current;
    await trustedDeviceRepository.extend(device.id, expiresAt, ip);
    setCookie(res, cookieName, `${token.id}.${token.secret}`, maxAgeSeconds);
    // A legacy cookie that verified for this user is theirs, so it is safe to retire, even
    // when the own cookie won (both can exist after a mixed-version rollout).
    if (presented.some(({ token: { legacy } }) => legacy)) expireCookie(res, LEGACY_TRUSTED_DEVICE_COOKIE);
    return device;
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
  setCookie(res, cookieName, `${device.id}.${secret}`, maxAgeSeconds);
  return device;
}

function secretMatches(secret: string, storedHash: string): boolean {
  const candidate = Buffer.from(sha256(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/**
 * The live trust for `userId` carried by this request, or null. Records the use but
 * does NOT extend the window - the 30 days run from the last genuine second-factor
 * pass, so a device always re-proves TOTP eventually. Never throws: any failure means
 * "not trusted", so a database blip degrades to the normal MFA challenge, not a bypass.
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
    const [current] = await findPresentedTrusts(req, userId);
    return current?.device ?? null;
  } catch {
    return null;
  }
}
