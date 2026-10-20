import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { AuditEntry } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  adminList: vi.fn(),
  authFind: vi.fn(),
  apiKeyFind: vi.fn(),
  findUserById: vi.fn(),
  findIdsWithAdminRights: vi.fn(),
  dailyNet: vi.fn(),
  findAdjustments: vi.fn(),
}));

/** A chainable stand-in for a mongoose query whose `.lean()` resolves to `rows`. */
const queryReturning = (rows: unknown[]) => {
  const query = {
    sort: () => query,
    limit: () => query,
    maxTimeMS: () => query,
    lean: () => Promise.resolve(rows),
  };
  return query;
};

vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: { list: (...args: unknown[]) => mocks.adminList(...args) },
  UserAuthAuditLogModel: { find: (...args: unknown[]) => mocks.authFind(...args) },
  UserApiKeyAuditLog: { find: (...args: unknown[]) => mocks.apiKeyFind(...args) },
  userRepository: { findById: (...args: unknown[]) => mocks.findUserById(...args) },
  organizationRepository: { findIdsWithAdminRights: (...args: unknown[]) => mocks.findIdsWithAdminRights(...args) },
  creditTransactionRepository: {
    dailyNetCreditsForOwner: (...args: unknown[]) => mocks.dailyNet(...args),
    findAdminAdjustmentsForUser: (...args: unknown[]) => mocks.findAdjustments(...args),
  },
}));

import {
  apiKeyAuditRowToEntry,
  authAuditRowToEntry,
  getUserCreditHistory,
  hasAdminHistory,
  listUserActivity,
  reconstructDailyBalances,
  unreliableBoundary,
  type ActivitySubject,
} from './userActivity';

const USER_ID = '650000000000000000000001';
const ADMIN_ID = '650000000000000000000002';
const subject: ActivitySubject = { id: USER_ID, name: 'Ada', email: 'ada@example.com', isAdmin: false };

const objectIdAt = (seconds: number) => Types.ObjectId.createFromTime(seconds);

const adminEntry = (id: string, occurredAt: Date): AuditEntry => ({
  id,
  source: 'admin',
  occurredAt,
  action: 'user.credits.adjusted',
  category: 'credits',
  severity: 'notice',
  actor: { kind: 'user', scope: 'platform', userId: ADMIN_ID, name: 'Root', wasAdmin: true },
  target: { kind: 'user', id: USER_ID, displayName: 'Ada' },
  summary: 'Adjusted credits',
  context: { source: 'admin_ui' },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.adminList.mockResolvedValue({ entries: [], nextCursor: null });
  mocks.authFind.mockReturnValue(queryReturning([]));
  mocks.apiKeyFind.mockReturnValue(queryReturning([]));
  mocks.findUserById.mockResolvedValue(null);
  mocks.findIdsWithAdminRights.mockResolvedValue([]);
});

describe('security-store adapters', () => {
  it('maps a self-performed auth event to a user-sourced identity entry', () => {
    const entry = authAuditRowToEntry(
      {
        _id: objectIdAt(100),
        userId: USER_ID,
        event: 'mfa_disabled',
        actorIp: '1.2.3.4',
        userAgent: 'ua',
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
      subject,
      new Map()
    );

    expect(entry).toMatchObject({
      source: 'auth',
      action: 'auth.mfa_disabled',
      category: 'identity',
      severity: 'notice',
      actor: { userId: USER_ID, name: 'Ada' },
      target: { kind: 'user', id: USER_ID },
      summary: 'Mfa disabled',
      context: { ip: '1.2.3.4', source: 'user' },
    });
  });

  it('attributes an auth event performed by someone else to that actor', () => {
    const entry = authAuditRowToEntry(
      {
        _id: objectIdAt(100),
        userId: USER_ID,
        event: 'session_revoked',
        actorUserId: ADMIN_ID,
        createdAt: new Date(),
      },
      subject,
      new Map([[ADMIN_ID, { name: 'Root', isAdmin: true }]])
    );

    expect(entry.actor).toMatchObject({ userId: ADMIN_ID, name: 'Root', wasAdmin: true });
    expect(entry.summary).toBe('Root: Session revoked for Ada');
    expect(entry.context.source).toBe('admin_ui');
  });

  it('flags theft-detection revocation as critical', () => {
    const entry = authAuditRowToEntry(
      { _id: objectIdAt(1), userId: USER_ID, event: 'session_reuse_revoked', createdAt: new Date() },
      subject,
      new Map()
    );
    expect(entry.severity).toBe('critical');
  });

  it('maps an API key event to an apiKey-sourced access entry targeting the key', () => {
    const entry = apiKeyAuditRowToEntry(
      { _id: objectIdAt(1), action: 'revoke', keyId: 'key-1', actorUserId: USER_ID, createdAt: new Date() },
      subject
    );

    expect(entry).toMatchObject({
      source: 'apiKey',
      action: 'api_key.revoke',
      category: 'access',
      severity: 'notice',
      target: { kind: 'apiKey', id: 'key-1' },
      summary: 'API key revoked',
    });
  });
});

describe('listUserActivity', () => {
  it('queries the admin log by target for the target direction and skips security stores by default', async () => {
    await listUserActivity(subject, { direction: 'target', includeSecurity: false, limit: 10 });

    expect(mocks.adminList).toHaveBeenCalledWith({ targetKind: 'user', targetId: USER_ID }, { limit: 10 });
    expect(mocks.authFind).not.toHaveBeenCalled();
    expect(mocks.apiKeyFind).not.toHaveBeenCalled();
  });

  it('queries by actor for the actor direction and never merges security events into it', async () => {
    await listUserActivity(subject, { direction: 'actor', includeSecurity: true, limit: 10 });

    expect(mocks.adminList).toHaveBeenCalledWith({ actorUserId: USER_ID }, { limit: 10 });
    expect(mocks.authFind).not.toHaveBeenCalled();
  });

  it('merges all sources newest first and cuts the page at the limit with a cursor on its last row', async () => {
    const newest = adminEntry(objectIdAt(300).toString(), new Date(300_000));
    const oldest = adminEntry(objectIdAt(100).toString(), new Date(100_000));
    mocks.adminList.mockResolvedValue({ entries: [newest, oldest], nextCursor: null });
    mocks.authFind.mockReturnValue(
      queryReturning([{ _id: objectIdAt(200), userId: USER_ID, event: 'login_success', createdAt: new Date(200_000) }])
    );
    mocks.apiKeyFind.mockReturnValue(
      queryReturning([
        { _id: objectIdAt(50), action: 'mint', keyId: 'k', actorUserId: USER_ID, createdAt: new Date(50_000) },
      ])
    );

    const page = await listUserActivity(subject, { direction: 'target', includeSecurity: true, limit: 3 });

    expect(page.entries.map(entry => entry.source)).toEqual(['admin', 'auth', 'admin']);
    expect(page.nextCursor).toEqual({ occurredAt: oldest.occurredAt, id: oldest.id });
  });

  it('applies the cursor to the security stores and reports no more pages when every source is exhausted', async () => {
    const cursor = { occurredAt: new Date(500_000), id: objectIdAt(500).toString() };

    const page = await listUserActivity(subject, { direction: 'target', includeSecurity: true, limit: 3, cursor });

    expect(mocks.adminList).toHaveBeenCalledWith(expect.anything(), { limit: 3, cursor });
    const authFilter = mocks.authFind.mock.calls[0]?.[0] as { $and: Array<Record<string, unknown>> };
    expect(authFilter.$and[0]).toEqual({ userId: USER_ID });
    expect(authFilter.$and[1]).toEqual({ createdAt: { $lte: cursor.occurredAt } });
    expect(page).toEqual({ entries: [], nextCursor: null });
  });

  it('keeps paging when the admin log has more even if the merged page is short', async () => {
    const only = adminEntry(objectIdAt(100).toString(), new Date(100_000));
    mocks.adminList.mockResolvedValue({ entries: [only], nextCursor: { occurredAt: only.occurredAt, id: only.id } });

    const page = await listUserActivity(subject, { direction: 'target', includeSecurity: false, limit: 1 });

    expect(page.nextCursor).toEqual({ occurredAt: only.occurredAt, id: only.id });
  });

  it('fails the page when a security store errors instead of returning a partial timeline', async () => {
    const failing = {
      sort: () => failing,
      limit: () => failing,
      maxTimeMS: () => failing,
      lean: () => Promise.reject(new Error('operation exceeded time limit')),
    };
    mocks.authFind.mockReturnValue(failing);

    await expect(listUserActivity(subject, { direction: 'target', includeSecurity: true, limit: 10 })).rejects.toThrow(
      'operation exceeded time limit'
    );
  });
});

describe('hasAdminHistory', () => {
  it('is true for a current platform admin without querying', async () => {
    await expect(hasAdminHistory({ ...subject, isAdmin: true })).resolves.toBe(true);
    expect(mocks.adminList).not.toHaveBeenCalled();
  });

  it('is true for an org admin', async () => {
    mocks.findIdsWithAdminRights.mockResolvedValue(['org-1']);
    await expect(hasAdminHistory(subject)).resolves.toBe(true);
  });

  it('is true for a former admin who appears as an actor in the log', async () => {
    mocks.adminList.mockResolvedValue({
      entries: [adminEntry(objectIdAt(1).toString(), new Date())],
      nextCursor: null,
    });
    await expect(hasAdminHistory(subject)).resolves.toBe(true);
    expect(mocks.adminList).toHaveBeenCalledWith({ actorUserId: USER_ID }, { limit: 1 });
  });

  it('is false for a user with no admin trace', async () => {
    await expect(hasAdminHistory(subject)).resolves.toBe(false);
  });
});

describe('reconstructDailyBalances', () => {
  it('walks back from the current balance, one point per day, oldest first', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const points = reconstructDailyBalances(
      100,
      [
        { day: '2026-10-18', netCredits: 50 },
        { day: '2026-10-20', netCredits: -10 },
      ],
      now,
      3
    );

    expect(points).toEqual([
      { day: '2026-10-17', balance: 60 },
      { day: '2026-10-18', balance: 110 },
      { day: '2026-10-19', balance: 110 },
      { day: '2026-10-20', balance: 100 },
    ]);
  });
});

describe('unreliableBoundary', () => {
  const from = new Date('2026-07-22T00:00:00Z');
  const now = new Date('2026-10-20T00:00:00Z');

  it('shades the whole window until the mandatory-ledger date is known', () => {
    expect(unreliableBoundary(null, from, now)).toBe(now.toISOString());
  });

  it('shades up to the date when it falls inside the window', () => {
    expect(unreliableBoundary('2026-09-01T00:00:00.000Z', from, now)).toBe('2026-09-01T00:00:00.000Z');
  });

  it('shades nothing once the date is before the window', () => {
    expect(unreliableBoundary('2026-01-01T00:00:00.000Z', from, now)).toBeNull();
  });
});

describe('getUserCreditHistory', () => {
  it('builds the series and markers, resolving actors and linking matching audit entries', async () => {
    const now = new Date('2026-10-20T12:00:00Z');
    mocks.dailyNet.mockResolvedValue([{ day: '2026-10-20', netCredits: 25 }]);
    mocks.findAdjustments.mockResolvedValue([
      {
        id: 'tx-1',
        credits: 25,
        createdAt: new Date('2026-10-20T08:00:00Z'),
        metadata: { actorId: ADMIN_ID, note: 'Goodwill' },
      },
    ]);
    mocks.adminList.mockResolvedValue({
      entries: [{ ...adminEntry('audit-1', now), related: { creditTransactionId: 'tx-1' } }],
      nextCursor: null,
    });
    mocks.findUserById.mockResolvedValue({ name: 'Root', email: 'root@example.com', isAdmin: true });

    const history = await getUserCreditHistory({ id: USER_ID, currentCredits: 125 }, now);

    expect(mocks.findAdjustments).toHaveBeenCalledWith(USER_ID, new Date('2026-07-22T00:00:00Z'), now, 201);
    expect(history.points).toHaveLength(91);
    expect(history.points.at(-1)).toEqual({ day: '2026-10-20', balance: 125 });
    expect(history.points.at(-2)).toEqual({ day: '2026-10-19', balance: 100 });
    expect(history.adjustments).toEqual([
      {
        transactionId: 'tx-1',
        occurredAt: '2026-10-20T08:00:00.000Z',
        credits: 25,
        actorUserId: ADMIN_ID,
        actorName: 'Root',
        reason: 'Goodwill',
        auditEntryId: 'audit-1',
      },
    ]);
    expect(history.adjustmentsTruncated).toBe(false);
  });
});
