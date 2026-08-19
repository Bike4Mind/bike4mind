import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

const mockFindValidForUser = vi.fn();
const mockCreate = vi.fn();
const mockExtend = vi.fn();
const mockTouch = vi.fn();

vi.mock('@bike4mind/database', () => ({
  TRUSTED_DEVICE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  adminSettingsRepository: { findAll: vi.fn(), findBySettingNames: vi.fn() },
  trustedDeviceRepository: {
    findValidForUser: (...a: any[]) => mockFindValidForUser(...a),
    create: (...a: any[]) => mockCreate(...a),
    extend: (...a: any[]) => mockExtend(...a),
    touch: (...a: any[]) => mockTouch(...a),
  },
}));

vi.mock('@server/utils/ip', () => ({ getClientIp: () => '203.0.113.9' }));

const mockGetSettingsMap = vi.fn(() => Promise.resolve({} as Record<string, string>));
let allowTrustedDevicesValue: unknown;
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: (...a: any[]) => mockGetSettingsMap(...(a as [])),
  getSettingsValue: () => allowTrustedDevicesValue,
}));

import {
  TRUSTED_DEVICE_COOKIE,
  clearTrustedDeviceCookie,
  consumeTrustedDevice,
  describeDevice,
  grantTrustedDevice,
  identifyTrustedDevice,
  trustedDevicesAllowed,
} from './trustedDevice';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const VALID_ID = '507f1f77bcf86cd799439011';
const VALID_SECRET = 'A'.repeat(43);

const makeReq = (cookie?: string): any => ({
  headers: { cookie, 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0 Safari/537.36' },
});

const makeRes = (): any => {
  const headers: Record<string, unknown> = {};
  return {
    getHeader: (name: string) => headers[name],
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
    },
    _headers: headers,
  };
};

const setCookieValues = (res: any): string[] => {
  const raw = res._headers['Set-Cookie'];
  return Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * The cookie is a factor-skip voucher. Every one of these cases is the difference
 * between "skips TOTP" and "does not", so the failure mode is an MFA bypass.
 */
describe('consumeTrustedDevice', () => {
  it('returns null when no cookie is presented', async () => {
    expect(await consumeTrustedDevice(makeReq(), 'user-a')).toBeNull();
    expect(mockFindValidForUser).not.toHaveBeenCalled();
  });

  it('returns null for a malformed cookie without hitting the database', async () => {
    expect(await consumeTrustedDevice(makeReq(`${TRUSTED_DEVICE_COOKIE}=garbage`), 'user-a')).toBeNull();
    expect(mockFindValidForUser).not.toHaveBeenCalled();
  });

  it('accepts a cookie whose secret hashes to the stored hash', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256(VALID_SECRET) });

    const device = await consumeTrustedDevice(
      makeReq(`${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`),
      'user-a'
    );

    expect(device?.id).toBe(VALID_ID);
    expect(mockFindValidForUser).toHaveBeenCalledWith(VALID_ID, 'user-a');
    expect(mockTouch).toHaveBeenCalledWith(VALID_ID, '203.0.113.9');
  });

  it('rejects a cookie carrying the right device id but the wrong secret', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256('the-real-secret') });

    const forged = `${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${'B'.repeat(43)}`;
    expect(await consumeTrustedDevice(makeReq(forged), 'user-a')).toBeNull();
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it('rejects when the repository scopes the device away from this user', async () => {
    mockFindValidForUser.mockResolvedValue(null);
    const cookie = `${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`;
    expect(await consumeTrustedDevice(makeReq(cookie), 'someone-else')).toBeNull();
  });

  it('degrades to "not trusted" when the database throws, never to a bypass', async () => {
    mockFindValidForUser.mockRejectedValue(new Error('mongo is down'));
    const cookie = `${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`;
    expect(await consumeTrustedDevice(makeReq(cookie), 'user-a')).toBeNull();
  });

  it('ignores an unrelated cookie of a similar name', async () => {
    expect(
      await consumeTrustedDevice(makeReq(`${TRUSTED_DEVICE_COOKIE}_other=${VALID_ID}.${VALID_SECRET}`), 'user-a')
    ).toBeNull();
    expect(mockFindValidForUser).not.toHaveBeenCalled();
  });

  it('finds its cookie among several', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256(VALID_SECRET) });
    const cookie = `theme=dark; ${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}; other=1`;
    expect(await consumeTrustedDevice(makeReq(cookie), 'user-a')).not.toBeNull();
  });
});

describe('identifyTrustedDevice', () => {
  it('resolves the same device as consume but records no use', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256(VALID_SECRET) });

    const device = await identifyTrustedDevice(
      makeReq(`${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`),
      'user-a'
    );

    expect(device?.id).toBe(VALID_ID);
    // Listing or revoking must not make "last used" read as today.
    expect(mockTouch).not.toHaveBeenCalled();
  });

  it('applies the same secret check as consume', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256('other') });
    const cookie = `${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`;
    expect(await identifyTrustedDevice(makeReq(cookie), 'user-a')).toBeNull();
  });
});

describe('grantTrustedDevice', () => {
  it('stores only a hash of the secret, never the secret itself', async () => {
    mockCreate.mockResolvedValue({ id: VALID_ID, expiresAt: new Date() });
    const res = makeRes();

    await grantTrustedDevice(makeReq(), res, 'user-a');

    const stored = mockCreate.mock.calls[0][0].tokenHash;
    const cookie = setCookieValues(res)[0];
    const secret = cookie.split('=')[1].split(';')[0].split('.')[1];

    expect(stored).toBe(sha256(secret));
    expect(stored).not.toContain(secret);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('sets an HttpOnly, SameSite=Lax cookie scoped to the trust window', async () => {
    mockCreate.mockResolvedValue({ id: VALID_ID, expiresAt: new Date() });
    const res = makeRes();

    await grantTrustedDevice(makeReq(), res, 'user-a');

    const cookie = setCookieValues(res)[0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain(`Max-Age=${Math.floor(TTL_MS / 1000)}`);
  });

  it('reuses and extends an existing trust instead of piling up a row per login', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256(VALID_SECRET) });
    const res = makeRes();

    const device = await grantTrustedDevice(
      makeReq(`${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`),
      res,
      'user-a'
    );

    expect(device?.id).toBe(VALID_ID);
    expect(mockExtend).toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('mints a fresh trust when the presented cookie does not verify', async () => {
    mockFindValidForUser.mockResolvedValue({ id: VALID_ID, tokenHash: sha256('a-different-secret') });
    mockCreate.mockResolvedValue({ id: '507f1f77bcf86cd799439012', expiresAt: new Date() });
    const res = makeRes();

    await grantTrustedDevice(makeReq(`${TRUSTED_DEVICE_COOKIE}=${VALID_ID}.${VALID_SECRET}`), res, 'user-a');

    expect(mockExtend).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalled();
  });

  it('appends to an existing Set-Cookie rather than clobbering it', async () => {
    mockCreate.mockResolvedValue({ id: VALID_ID, expiresAt: new Date() });
    const res = makeRes();
    res.setHeader('Set-Cookie', 'session=abc; Path=/');

    await grantTrustedDevice(makeReq(), res, 'user-a');

    const cookies = setCookieValues(res);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('session=abc');
    expect(cookies[1]).toContain(TRUSTED_DEVICE_COOKIE);
  });
});

describe('clearTrustedDeviceCookie', () => {
  it('expires the cookie immediately', () => {
    const res = makeRes();
    clearTrustedDeviceCookie(res);
    expect(setCookieValues(res)[0]).toContain('Max-Age=0');
  });
});

describe('describeDevice', () => {
  it('summarises a user agent for display', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0 Safari/537.36')).toBe(
      'Chrome on macOS'
    );
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Firefox/121.0')).toBe('Firefox on Windows');
  });

  it('falls back when the header is absent', () => {
    expect(describeDevice(undefined)).toBe('Unknown device');
  });
});

describe('trustedDevicesAllowed', () => {
  beforeEach(() => {
    allowTrustedDevicesValue = undefined;
  });

  it('reads the kill switch uncached so a flip takes effect on every warm instance', async () => {
    await trustedDevicesAllowed();

    expect(mockGetSettingsMap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ skipCache: true, names: ['allowTrustedDevices'] })
    );
  });

  it('denies once the switch is off', async () => {
    allowTrustedDevicesValue = false;
    expect(await trustedDevicesAllowed()).toBe(false);

    allowTrustedDevicesValue = true;
    expect(await trustedDevicesAllowed()).toBe(true);
  });
});
