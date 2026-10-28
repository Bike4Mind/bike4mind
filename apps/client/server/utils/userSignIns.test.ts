import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { authMethodLabel, normalizeAuthMethod, type ILoginRecord } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({ authFind: vi.fn(), userFind: vi.fn() }));

const queryReturning = (rows: unknown[]) => {
  const query = {
    select: () => query,
    sort: () => query,
    limit: () => query,
    maxTimeMS: () => query,
    lean: () => Promise.resolve(rows),
  };
  return query;
};

vi.mock('@bike4mind/database', () => ({
  UserAuthAuditLogModel: { find: (...args: unknown[]) => mocks.authFind(...args) },
  User: { find: (...args: unknown[]) => mocks.userFind(...args) },
}));

import {
  authRowToSignIn,
  describeUserAgent,
  findSignupCluster,
  listUserSignIns,
  MAX_SIGNUP_CLUSTER_MATCHES,
  matchLoginRecord,
} from './userSignIns';
import type { UserAuthAuditRow } from './userActivity';

const USER_ID = '650000000000000000000001';
const AT = new Date('2026-10-20T12:00:00.000Z');
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const row = (overrides: Partial<UserAuthAuditRow> = {}): UserAuthAuditRow => ({
  _id: new Types.ObjectId(),
  userId: USER_ID,
  event: 'login_success',
  strategy: 'google',
  actorIp: '198.51.100.4',
  userAgent: CHROME_MAC,
  createdAt: AT,
  ...overrides,
});

const record = (overrides: Partial<ILoginRecord> = {}) =>
  ({
    loginTime: new Date(AT.getTime() + 30_000),
    ip: '198.51.100.4',
    location: 'Lisbon, PT',
    browser: 'Chrome',
    operatingSystem: 'macOS',
    deviceType: 'Desktop',
    ...overrides,
  }) as ILoginRecord;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth method normalization', () => {
  it('maps stored strategies, aliases and legacy values', () => {
    expect(normalizeAuthMethod('google')).toBe('google');
    expect(normalizeAuthMethod('local')).toBe('password');
    expect(normalizeAuthMethod('  OTC ')).toBe('otc');
    expect(normalizeAuthMethod('magic-link')).toBe('other');
    expect(normalizeAuthMethod('')).toBeNull();
    expect(normalizeAuthMethod(undefined)).toBeNull();
  });

  it('labels a legacy value as stored instead of hiding it', () => {
    expect(authMethodLabel('saml')).toBe('SSO (SAML)');
    expect(authMethodLabel('magic-link')).toBe('Other (magic-link)');
    expect(authMethodLabel(null)).toBeUndefined();
  });
});

describe('describeUserAgent', () => {
  it('reads a coarse browser and OS', () => {
    expect(describeUserAgent(CHROME_MAC)).toEqual({ browser: 'Chrome', operatingSystem: 'macOS' });
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1')).toEqual({
      browser: 'Safari',
      operatingSystem: 'iOS',
    });
    expect(describeUserAgent(undefined)).toEqual({});
  });
});

describe('matchLoginRecord', () => {
  it('picks the closest record within five minutes on the same IP', () => {
    const near = record({ loginTime: new Date(AT.getTime() + 10_000), location: 'Near' });
    const far = record({ loginTime: new Date(AT.getTime() + 200_000), location: 'Far' });
    expect(matchLoginRecord(AT, '198.51.100.4', [far, near])?.location).toBe('Near');
  });

  it('ignores records too far away or from another IP', () => {
    expect(matchLoginRecord(AT, '198.51.100.4', [record({ loginTime: new Date(AT.getTime() + 600_000) })])).toBe(
      undefined
    );
    expect(matchLoginRecord(AT, '198.51.100.4', [record({ ip: '203.0.113.9' })])).toBeUndefined();
  });
});

describe('authRowToSignIn', () => {
  it('maps each event to its result', () => {
    expect(authRowToSignIn(row(), []).result).toBe('success');
    expect(authRowToSignIn(row({ event: 'step_up_failed' }), []).result).toBe('failed');
    expect(authRowToSignIn(row({ event: 'session_reuse_revoked' }), []).result).toBe('blocked');
  });

  it('enriches a successful sign-in from the matching login record', () => {
    expect(authRowToSignIn(row(), [record()])).toMatchObject({
      method: 'google',
      ip: '198.51.100.4',
      location: 'Lisbon, PT',
      browser: 'Chrome',
      operatingSystem: 'macOS',
      deviceType: 'Desktop',
    });
  });

  it('falls back to the user agent and leaves unknown fields absent', () => {
    const signIn = authRowToSignIn(row({ strategy: undefined, actorIp: '' }), []);
    expect(signIn).toMatchObject({ browser: 'Chrome', operatingSystem: 'macOS' });
    expect(signIn.method).toBeUndefined();
    expect(signIn.ip).toBeUndefined();
    expect(signIn.location).toBeUndefined();
  });

  it("reads the user agent when the login record holds the recorder's literal 'Unknown'", () => {
    const signIn = authRowToSignIn(row(), [
      record({ browser: 'Unknown', operatingSystem: 'Unknown', location: 'Unknown', deviceType: 'Desktop' }),
    ]);
    expect(signIn).toMatchObject({ browser: 'Chrome', operatingSystem: 'macOS', deviceType: 'Desktop' });
    expect(signIn.location).toBeUndefined();
  });
});

describe('listUserSignIns', () => {
  it('queries only sign-in events for the user and pages on the last row', async () => {
    const rows = [row({ createdAt: new Date(AT.getTime() + 2000) }), row({ createdAt: AT }), row()];
    mocks.authFind.mockReturnValue(queryReturning(rows));

    const page = await listUserSignIns(USER_ID, [], { limit: 2 });

    const filter = mocks.authFind.mock.calls[0][0] as { $and: Array<Record<string, unknown>> };
    expect(filter.$and[0]).toMatchObject({
      userId: USER_ID,
      event: { $in: expect.arrayContaining(['login_success']) },
    });
    expect((filter.$and[0].event as { $in: string[] }).$in).not.toContain('logout');
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toEqual({ occurredAt: AT, id: rows[1]._id.toString() });
  });

  it('reports no next page when the store is exhausted', async () => {
    mocks.authFind.mockReturnValue(queryReturning([row()]));
    expect((await listUserSignIns(USER_ID, [], { limit: 2 })).nextCursor).toBeNull();
  });
});

describe('findSignupCluster', () => {
  it('reports no fingerprint without querying', async () => {
    const cluster = await findSignupCluster({ id: USER_ID, createdAt: AT });
    expect(cluster).toMatchObject({ fingerprintAvailable: false, matches: [] });
    expect(mocks.userFind).not.toHaveBeenCalled();
  });

  it('finds other accounts with the same fingerprint within the window and caps the list', async () => {
    const rows = Array.from({ length: MAX_SIGNUP_CLUSTER_MATCHES + 1 }, (_, index) => ({
      _id: new Types.ObjectId(),
      name: index === 0 ? '' : `User ${index}`,
      email: `user${index}@example.com`,
      createdAt: AT,
    }));
    mocks.userFind.mockReturnValue(queryReturning(rows));

    const cluster = await findSignupCluster({ id: USER_ID, createdAt: AT, signupMeta: { ja4: 'fp' } });

    expect(mocks.userFind).toHaveBeenCalledWith({
      createdAt: { $gte: new Date('2026-10-13T12:00:00.000Z'), $lte: new Date('2026-10-27T12:00:00.000Z') },
      'signupMeta.ja4': 'fp',
      _id: { $ne: USER_ID },
    });
    expect(cluster.matches).toHaveLength(MAX_SIGNUP_CLUSTER_MATCHES);
    expect(cluster.matches[0].name).toBe('user0@example.com');
    expect(cluster.truncated).toBe(true);
  });
});
