import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Row = Record<string, unknown> & { _id: { toString(): string } };
type Entry = { id: string };

const state = vi.hoisted(() => ({
  ledgerRows: [] as Row[],
  counterRows: [] as Row[],
  users: [] as Row[],
  seenIds: new Set<string>(),
  appendCalls: [] as Entry[][],
}));

const { sourceQuery } = vi.hoisted(() => {
  const sourceQuery = (rows: () => Row[]) => ({
    find: (filter: { _id?: { $gt: { toString(): string } } }) => {
      const after = filter._id?.$gt.toString();
      const page = () => rows().filter(row => after === undefined || row._id.toString() > after);
      const query = {
        sort: () => query,
        limit: (count: number) => ({ lean: async () => page().slice(0, count) }),
      };
      return query;
    },
  });
  return { sourceQuery };
});

vi.mock('@bike4mind/database', () => ({
  CreditTransaction: sourceQuery(() => state.ledgerRows),
  CounterLog: sourceQuery(() => state.counterRows),
  User: {
    find: (filter: { _id: { $in: string[] } }) => ({
      select: () => ({
        lean: async () => state.users.filter(user => filter._id.$in.includes(user._id.toString())),
      }),
    }),
  },
  adminAuditLogRepository: {
    appendBackfill: async (entries: Entry[]) => {
      state.appendCalls.push(entries);
      let inserted = 0;
      let duplicates = 0;
      for (const { id } of entries) {
        if (state.seenIds.has(id)) duplicates += 1;
        else {
          state.seenIds.add(id);
          inserted += 1;
        }
      }
      return { inserted, duplicates };
    },
  },
}));

import migration, {
  mapCounterLogRowToEntry,
  mapLedgerRowToEntry,
  resolveCounterLogActorId,
  type ActorUser,
  type CounterLogRow,
  type LedgerRow,
} from './20260921235941_backfill-admin-audit-log';

const ADMIN_ID = '64b000000000000000000001';
const admin: ActorUser = { _id: ADMIN_ID, name: 'Ada Admin', username: 'ada', email: 'ada@example.com', isAdmin: true };
const createdAt = new Date('2025-03-01T10:00:00Z');

const ledgerRow = (overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  _id: '64a000000000000000000001',
  type: 'generic_add',
  ownerId: 'owner-1',
  userId: 'user-1',
  credits: 500,
  createdAt,
  metadata: { actorId: ADMIN_ID, previousBalance: 100, resultingBalance: 600, note: 'goodwill' },
  ...overrides,
});

const counterRow = (counterName: string, metadata: unknown, overrides: Partial<CounterLogRow> = {}): CounterLogRow => ({
  _id: '64c000000000000000000001',
  userId: 'target-user',
  counterName,
  datetime: createdAt,
  metadata,
  ...overrides,
});

describe('mapLedgerRowToEntry', () => {
  it('maps an admin credit grant with actor, balances and reason', () => {
    const entry = mapLedgerRowToEntry(ledgerRow(), admin);

    expect(entry).toEqual({
      id: '64a000000000000000000001',
      occurredAt: createdAt,
      action: 'user.credits.adjusted',
      category: 'credits',
      severity: 'notice',
      actor: {
        kind: 'user',
        scope: 'platform',
        userId: ADMIN_ID,
        email: 'ada@example.com',
        name: 'Ada Admin',
        wasAdmin: true,
      },
      target: { kind: 'user', id: 'owner-1', displayName: 'owner-1' },
      summary: 'granted 500 credits',
      reason: 'goodwill',
      changes: [{ field: 'currentCredits', before: 100, after: 600 }],
      context: { source: 'admin_ui' },
      related: { creditTransactionId: '64a000000000000000000001' },
      backfilled: true,
    });
  });

  it('uses the unknown system actor and omits changes when the row has no actor or balances', () => {
    const entry = mapLedgerRowToEntry(ledgerRow({ metadata: { note: 'x' }, ownerId: undefined }), null);

    expect(entry.actor).toEqual({
      kind: 'system',
      scope: 'platform',
      name: 'Unknown (pre-audit)',
      wasAdmin: false,
    });
    expect(entry.target.id).toBe('user-1');
    expect(entry.changes).toBeUndefined();
  });

  it('describes a deduction using the credit magnitude', () => {
    const entry = mapLedgerRowToEntry(ledgerRow({ type: 'generic_deduct', credits: -250 }), admin);

    expect(entry.summary).toBe('deducted 250 credits');
  });
});

describe('mapCounterLogRowToEntry', () => {
  it('returns null for a row without adminUserId when the old call had a distinct admin field', () => {
    const row = counterRow('ORG_TOPPED_UP', { metadata: { organizationId: 'org-1', credits: 5 } });

    expect(resolveCounterLogActorId(row)).toBeUndefined();
    expect(mapCounterLogRowToEntry(row, admin)).toBeNull();
  });

  it('returns null for an event that stayed on the analytics log', () => {
    expect(mapCounterLogRowToEntry(counterRow('LAKE_DOCUMENT_PURGED', { adminUserId: ADMIN_ID }), admin)).toBeNull();
  });

  it('maps ORG_GRANTED with an organizationId to org.credits.granted targeting the organization', () => {
    const row = counterRow('ORG_GRANTED', {
      adminUserId: ADMIN_ID,
      reason: 'pilot',
      ip: '10.0.0.1',
      metadata: { organizationId: 'org-1', organizationName: 'Acme', seats: 5, initialCredits: 1000 },
    });

    const entry = mapCounterLogRowToEntry(row, admin);

    expect(entry).toMatchObject({
      id: '64c000000000000000000001',
      action: 'org.credits.granted',
      category: 'credits',
      target: { kind: 'organization', id: 'org-1', displayName: 'Acme' },
      organizationId: 'org-1',
      summary: 'granted org with 5 seats and 1000 initial credits',
      reason: 'pilot',
      details: { seats: 5, initialCredits: 1000, ownerId: 'target-user' },
      context: { source: 'admin_ui', ip: '10.0.0.1' },
      occurredAt: createdAt,
      backfilled: true,
    });
  });

  it('maps ORG_GRANTED without an organizationId to user.subscription.granted targeting the user', () => {
    const row = counterRow('ORG_GRANTED', {
      adminUserId: ADMIN_ID,
      metadata: { subscriptionType: 'individual', priceId: 'price-1', credits: 100, durationMonths: 3 },
    });

    const entry = mapCounterLogRowToEntry(row, admin);

    expect(entry).toMatchObject({
      action: 'user.subscription.granted',
      target: { kind: 'user', id: 'target-user' },
      summary: 'granted individual subscription',
      details: { priceId: 'price-1', credits: 100, durationMonths: 3 },
    });
    expect(entry?.organizationId).toBeUndefined();
  });

  it('keeps a team subscription grant on the user action even though it carries organizationId', () => {
    const row = counterRow('ORG_GRANTED', {
      adminUserId: ADMIN_ID,
      metadata: { subscriptionType: 'team', organizationId: 'org-9', seats: 3 },
    });

    expect(mapCounterLogRowToEntry(row, admin)).toMatchObject({
      action: 'user.subscription.granted',
      organizationId: 'org-9',
      target: { kind: 'user' },
    });
  });

  it('redacts secret-looking keys in details', () => {
    const row = counterRow('OAUTH_CLIENT_CREATED', {
      adminUserId: ADMIN_ID,
      metadata: { oauthClientId: 'oc-1', name: 'Portal', clientSecret: 'hunter2', clientType: 'confidential' },
    });

    const entry = mapCounterLogRowToEntry(row, admin);

    expect(entry?.target).toEqual({ kind: 'oauthClient', id: 'oc-1', displayName: 'Portal' });
    expect(entry?.details).toEqual({ clientSecret: '[REDACTED]', clientType: 'confidential' });
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('attributes events whose old call wrote no adminUserId to the row userId', () => {
    const row = counterRow('ADMIN_DATABASE_TEST', {}, { userId: ADMIN_ID });

    expect(resolveCounterLogActorId(row)).toBe(ADMIN_ID);
    expect(mapCounterLogRowToEntry(row, admin)).toMatchObject({
      action: 'system_health.test_run',
      summary: 'tested the database connection',
      actor: { userId: ADMIN_ID },
    });
  });

  it('only treats a manual attack-simulation trigger as an admin action', () => {
    const manual = counterRow(
      'SECURITY_SCAN_SCHEDULE_TRIGGERED',
      { metadata: { scanType: 'attack-simulation', trigger: 'manual', runId: 'r1' } },
      { userId: ADMIN_ID }
    );
    const cron = counterRow(
      'SECURITY_SCAN_SCHEDULE_TRIGGERED',
      { metadata: { scanType: 'web', scheduleId: 's1' } },
      { userId: ADMIN_ID }
    );

    expect(mapCounterLogRowToEntry(manual, admin)?.action).toBe('security.attack_simulation.run');
    expect(mapCounterLogRowToEntry(cron, admin)).toBeNull();
  });

  it('records an organization-scoped actor for org group events', () => {
    const row = counterRow(
      'ORG_GROUP_MEMBER_ASSIGNED',
      { metadata: { organizationId: 'org-1', groupId: 'g1', targetUserId: 'u2' } },
      { userId: ADMIN_ID }
    );

    expect(mapCounterLogRowToEntry(row, admin)).toMatchObject({
      action: 'org.group_member.assigned',
      actor: { scope: 'organization' },
      details: { groupId: 'g1', targetUserId: 'u2' },
    });
  });

  it('backfills a system-raised seat ceiling under the live path system actor with worker source', () => {
    const row = counterRow(
      'ORG_SEAT_CEILING_RAISED',
      {
        reason: 'partner-rule domain signup (signup)',
        metadata: { organizationId: 'org-1', previousSeats: 5, newSeats: 6, trigger: 'signup' },
      },
      { userId: 'admitted-user' }
    );

    expect(resolveCounterLogActorId(row)).toBeUndefined();
    expect(mapCounterLogRowToEntry(row, null)).toMatchObject({
      action: 'org.seats.ceiling_raised',
      actor: { kind: 'system', scope: 'platform', name: 'Seat ceiling', wasAdmin: false },
      context: { source: 'worker' },
      target: { kind: 'organization', id: 'org-1' },
      summary: 'raised seat ceiling from 5 to 6',
      details: { userId: 'admitted-user', trigger: 'signup' },
    });
  });

  it('backfills an admin-attributed seat ceiling raise with the admin actor and script source', () => {
    const row = counterRow('ORG_SEAT_CEILING_RAISED', {
      adminUserId: ADMIN_ID,
      metadata: { organizationId: 'org-1', previousSeats: 5, newSeats: 6, trigger: 'backfill' },
    });

    expect(mapCounterLogRowToEntry(row, admin)).toMatchObject({
      actor: { kind: 'user', userId: ADMIN_ID },
      context: { source: 'script' },
    });
  });

  it('turns whats-new changedFields and old/new config into per-field changes', () => {
    const row = counterRow(
      'WHATS_NEW_CONFIG_UPDATED',
      { oldConfig: { a: 1, b: 2 }, newConfig: { a: 1, b: 3 }, changedFields: ['b'] },
      { userId: ADMIN_ID }
    );

    const entry = mapCounterLogRowToEntry(row, admin);

    expect(entry?.changes).toEqual([{ field: 'b', before: 2, after: 3 }]);
    expect(entry?.details).toBeUndefined();
  });

  it('falls back to a single config change row for restores and rows without changedFields', () => {
    const restore = counterRow(
      'WHATS_NEW_CONFIG_UPDATED',
      { oldConfig: { a: 1 }, newConfig: { a: 2 }, changedFields: ['restored_from_history'] },
      { userId: ADMIN_ID }
    );
    const nested = counterRow(
      'WHATS_NEW_CONFIG_UPDATED',
      { metadata: { oldConfig: { a: 1 }, newConfig: { a: 2 } } },
      { userId: ADMIN_ID }
    );

    expect(mapCounterLogRowToEntry(restore, admin)).toMatchObject({
      summary: 'restored the configuration from history',
      changes: [{ field: 'config', before: { a: 1 }, after: { a: 2 } }],
    });
    expect(mapCounterLogRowToEntry(nested, admin)?.changes).toEqual([
      { field: 'config', before: { a: 1 }, after: { a: 2 } },
    ]);
  });

  it('builds before/after changes for an oauth client update', () => {
    const row = counterRow('OAUTH_CLIENT_UPDATED', {
      adminUserId: ADMIN_ID,
      oldConfig: { redirectUris: ['a'], isActive: true },
      newConfig: { redirectUris: ['a'], isActive: false },
      metadata: { oauthClientId: 'oc-1', name: 'Portal' },
    });

    expect(mapCounterLogRowToEntry(row, admin)?.changes).toEqual([{ field: 'isActive', before: true, after: false }]);
  });
});

describe('backfill-admin-audit-log up()', () => {
  beforeEach(() => {
    state.ledgerRows = [
      { ...ledgerRow({ _id: '64a000000000000000000001' }) },
      { ...ledgerRow({ _id: '64a000000000000000000002', type: 'generic_deduct', credits: -5 }) },
    ];
    state.counterRows = [
      { ...counterRow('ORG_TOPPED_UP', { adminUserId: ADMIN_ID, metadata: { organizationId: 'org-1', credits: 7 } }) },
      {
        ...counterRow('ORG_TOPPED_UP', { metadata: { organizationId: 'org-1' } }, { _id: '64c000000000000000000002' }),
      },
    ];
    state.users = [{ _id: ADMIN_ID, name: 'Ada Admin', isAdmin: true }];
    state.seenIds = new Set();
    state.appendCalls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('inserts mappable rows, skips the rest, and logs per-source counts', async () => {
    await migration.up();

    expect(state.seenIds.size).toBe(3);
    const logs = vi.mocked(console.log).mock.calls.map(call => String(call[0]));
    expect(logs).toContain(
      '[backfill-admin-audit-log] {"source":"creditTransactions","scanned":2,"inserted":2,"duplicates":0,"skipped":0}'
    );
    expect(logs).toContain(
      '[backfill-admin-audit-log] {"source":"counterLogs","scanned":2,"inserted":1,"duplicates":0,"skipped":1}'
    );
  });

  it('inserts nothing and does not throw when run a second time', async () => {
    await migration.up();
    const idsAfterFirstRun = new Set(state.seenIds);

    await expect(migration.up()).resolves.toBeUndefined();

    expect(state.seenIds).toEqual(idsAfterFirstRun);
    const logs = vi.mocked(console.log).mock.calls.map(call => String(call[0]));
    expect(logs).toContain(
      '[backfill-admin-audit-log] {"source":"creditTransactions","scanned":2,"inserted":0,"duplicates":2,"skipped":0}'
    );
    expect(logs).toContain(
      '[backfill-admin-audit-log] {"source":"counterLogs","scanned":2,"inserted":0,"duplicates":1,"skipped":1}'
    );
  });

  it('pages through sources in batches without re-reading rows', async () => {
    state.ledgerRows = Array.from({ length: 1200 }, (_, index) =>
      ledgerRow({ _id: `64a${String(index).padStart(21, '0')}`.slice(0, 24) })
    ) as unknown as Row[];
    state.counterRows = [];

    await migration.up();

    expect(state.seenIds.size).toBe(1200);
    expect(state.appendCalls.map(call => call.length)).toEqual([500, 500, 200]);
  });
});
