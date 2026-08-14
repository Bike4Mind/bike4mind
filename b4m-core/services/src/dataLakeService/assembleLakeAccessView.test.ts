import { describe, it, expect, vi } from 'vitest';
import type {
  IDataLakeAccessGrantDocument,
  IDataLakeDocument,
  ILakeAccessEventDocument,
  LakeAccessSurface,
} from '@bike4mind/common';
import {
  aggregateAccessHistory,
  assembleLakeAccessView,
  classifyGrantStatus,
  deriveAccessChannels,
} from './assembleLakeAccessView';

const NOW = new Date('2026-08-14T12:00:00.000Z');

describe('classifyGrantStatus - matches the DB active-grant boundary exactly', () => {
  it('no expiry is always active', () => {
    expect(classifyGrantStatus(undefined, NOW)).toBe('active');
    expect(classifyGrantStatus(null, NOW)).toBe('active');
  });
  it('an expiry strictly in the future is active', () => {
    expect(classifyGrantStatus(new Date(NOW.getTime() + 1000), NOW)).toBe('active');
  });
  it('an expiry exactly at now is expired (boundary excluded from active, like buildActiveGrantFilter $gt)', () => {
    expect(classifyGrantStatus(new Date(NOW.getTime()), NOW)).toBe('expired');
  });
  it('an expiry in the past is expired', () => {
    expect(classifyGrantStatus(new Date(NOW.getTime() - 1000), NOW)).toBe('expired');
  });
});

describe('deriveAccessChannels - gate-based read paths in a stable order', () => {
  const lake = (over: Partial<IDataLakeDocument> = {}) =>
    ({
      organizationId: undefined,
      requiredUserTag: undefined,
      requiredEntitlement: undefined,
      isPublic: false,
      ...over,
    }) as IDataLakeDocument;

  it('a private, ungated lake has no channels', () => {
    expect(deriveAccessChannels(lake())).toEqual([]);
  });
  it('emits tag, entitlement, org, public in that fixed order', () => {
    expect(
      deriveAccessChannels(
        lake({ requiredUserTag: 'vip', requiredEntitlement: 'product:pro', organizationId: 'orgA', isPublic: true })
      )
    ).toEqual([
      { kind: 'tag', value: 'vip' },
      { kind: 'entitlement', value: 'product:pro' },
      { kind: 'organization', value: 'orgA' },
      { kind: 'public' },
    ]);
  });
});

const event = (over: Partial<ILakeAccessEventDocument>): ILakeAccessEventDocument =>
  ({
    principalKind: 'user',
    principalId: 'u1',
    surface: 'data-lake-semantic-search' as LakeAccessSurface,
    createdAt: NOW,
    resolvedLakeIds: ['lake1'],
    returnedChunkIds: [],
    returnedFileIds: [],
    returnedChunkCount: 0,
    returnedFileCount: 0,
    identifiersTruncated: false,
    queryTextLogged: false,
    expiresAt: NOW,
    id: 'e',
    updatedAt: NOW,
    ...over,
  }) as ILakeAccessEventDocument;

describe('aggregateAccessHistory', () => {
  it('collapses to one row per principal with counts, first/last, and distinct sorted surfaces', () => {
    const t0 = new Date('2026-08-10T00:00:00Z');
    const t1 = new Date('2026-08-11T00:00:00Z');
    const t2 = new Date('2026-08-12T00:00:00Z');
    const rows = aggregateAccessHistory([
      event({ principalId: 'u1', createdAt: t1, surface: 'chat-kb-search' }),
      event({ principalId: 'u1', createdAt: t0, surface: 'data-lake-semantic-search' }),
      event({ principalId: 'u1', createdAt: t2, surface: 'chat-kb-search' }),
      event({ principalId: 'u2', createdAt: t1, surface: 'forced-retrieval' }),
    ]);
    expect(rows).toHaveLength(2);
    const u1 = rows.find(r => r.principalId === 'u1')!;
    expect(u1.readCount).toBe(3);
    expect(u1.firstAccessedAt).toEqual(t0);
    expect(u1.lastAccessedAt).toEqual(t2);
    expect(u1.surfaces).toEqual(['chat-kb-search', 'data-lake-semantic-search']); // distinct + sorted
  });

  it('groups by ACTING principal, not the on-behalf human, but retains the human', () => {
    const rows = aggregateAccessHistory([
      event({ principalKind: 'agent', principalId: 'agentX', onBehalfOfUserId: 'human1' }),
      event({ principalKind: 'agent', principalId: 'agentX' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].principalKind).toBe('agent');
    expect(rows[0].onBehalfOfUserId).toBe('human1');
  });

  it('sorts most-recently-active first', () => {
    const rows = aggregateAccessHistory([
      event({ principalId: 'old', createdAt: new Date('2026-01-01T00:00:00Z') }),
      event({ principalId: 'new', createdAt: new Date('2026-08-01T00:00:00Z') }),
    ]);
    expect(rows.map(r => r.principalId)).toEqual(['new', 'old']);
  });

  it('empty input yields no rows', () => {
    expect(aggregateAccessHistory([])).toEqual([]);
  });
});

const grant = (over: Partial<IDataLakeAccessGrantDocument>): IDataLakeAccessGrantDocument =>
  ({
    dataLakeId: 'lake1',
    principalType: 'user',
    principalId: 'u1',
    role: 'reader',
    grantedByUserId: 'owner1',
    expiresAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    id: 'g',
    ...over,
  }) as IDataLakeAccessGrantDocument;

const makeAdapters = (opts: {
  grants?: IDataLakeAccessGrantDocument[];
  events?: ILakeAccessEventDocument[];
  users?: { id: string; name?: string; username?: string; email?: string | null }[];
  org?: { name: string; userId: string; users: { userId: string }[] } | null;
}) => {
  const listByLakeGrants = vi.fn().mockResolvedValue(opts.grants ?? []);
  const listByLakeEvents = vi.fn().mockResolvedValue(opts.events ?? []);
  const findByIds = vi.fn().mockResolvedValue(opts.users ?? []);
  const findById = vi.fn().mockResolvedValue(opts.org ?? null);
  return {
    spies: { listByLakeGrants, listByLakeEvents, findByIds, findById },
    adapters: {
      db: {
        dataLakeAccessGrants: { listByLake: listByLakeGrants },
        lakeAccessEvents: { listByLake: listByLakeEvents },
        users: { findByIds },
        organizations: { findById },
      },
      now: NOW,
    } as never,
  };
};

const lakeDoc = (over: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Sales Intelligence',
    organizationId: undefined,
    requiredUserTag: undefined,
    requiredEntitlement: undefined,
    isPublic: false,
    ...over,
  }) as IDataLakeDocument;

describe('assembleLakeAccessView', () => {
  it('maps grant rows, resolving names and flagging expiry against `now`', async () => {
    const { adapters } = makeAdapters({
      grants: [
        grant({ principalId: 'u1', role: 'reader', grantedByUserId: 'owner1', expiresAt: new Date(NOW.getTime() - 1) }),
        grant({ principalId: 'u2', role: 'curator', grantedByUserId: 'owner1', expiresAt: null }),
      ],
      users: [
        { id: 'u1', name: 'Alice' },
        { id: 'u2', name: 'Bob' },
        { id: 'owner1', name: 'Olivia Owner' },
      ],
    });
    const view = await assembleLakeAccessView(lakeDoc(), adapters);
    expect(view.grants).toHaveLength(2);
    const alice = view.grants.find(g => g.principalId === 'u1')!;
    expect(alice).toMatchObject({
      principalName: 'Alice',
      role: 'reader',
      grantedByName: 'Olivia Owner',
      status: 'expired',
    });
    const bob = view.grants.find(g => g.principalId === 'u2')!;
    expect(bob.status).toBe('active');
    expect(view.generatedAt).toEqual(NOW);
  });

  it('a deleted grantee still renders as a row (name undefined), so the audit set stays complete', async () => {
    const { adapters } = makeAdapters({ grants: [grant({ principalId: 'ghost' })], users: [] });
    const view = await assembleLakeAccessView(lakeDoc(), adapters);
    expect(view.grants[0]).toMatchObject({ principalId: 'ghost', principalName: undefined });
  });

  it('enriches the org channel with the org name and a de-duplicated member count', async () => {
    const { adapters } = makeAdapters({
      org: { name: 'Acme', userId: 'ownerU', users: [{ userId: 'ownerU' }, { userId: 'm2' }, { userId: 'm3' }] },
    });
    const view = await assembleLakeAccessView(lakeDoc({ organizationId: 'orgA' }), adapters);
    const org = view.channels.find(c => c.kind === 'organization')!;
    expect(org).toMatchObject({ value: 'orgA', label: 'Acme', holderCount: 3 }); // ownerU counted once
  });

  it('leaves tag/entitlement channels without a holderCount (never scans the user table)', async () => {
    const { adapters } = makeAdapters({});
    const view = await assembleLakeAccessView(
      lakeDoc({ requiredUserTag: 'vip', requiredEntitlement: 'product:pro' }),
      adapters
    );
    expect(view.channels.find(c => c.kind === 'tag')).toEqual({ kind: 'tag', value: 'vip' });
    expect(view.channels.find(c => c.kind === 'entitlement')?.holderCount).toBeUndefined();
  });

  it('resolves org-principal grant names via findById', async () => {
    const { adapters } = makeAdapters({
      grants: [
        grant({ principalType: 'organization', principalId: 'orgA', role: 'reader', grantedByUserId: 'owner1' }),
      ],
      org: { name: 'Acme', userId: 'x', users: [] },
      users: [{ id: 'owner1', name: 'Olivia' }],
    });
    const view = await assembleLakeAccessView(lakeDoc(), adapters);
    expect(view.grants[0]).toMatchObject({
      principalType: 'organization',
      principalName: 'Acme',
      grantedByName: 'Olivia',
    });
  });

  it('aggregates history and marks truncation when the event read hits the cap', async () => {
    const events = [event({ principalId: 'u1' }), event({ principalId: 'u1' })];
    const { adapters, spies } = makeAdapters({ events, users: [{ id: 'u1', name: 'Alice' }] });
    const view = await assembleLakeAccessView(lakeDoc(), {
      ...(adapters as object),
      historyLimit: 2,
      now: NOW,
    } as never);
    expect(spies.listByLakeEvents).toHaveBeenCalledWith('lake1', { limit: 2 });
    expect(view.history).toHaveLength(1);
    expect(view.history[0]).toMatchObject({ principalName: 'Alice', readCount: 2 });
    expect(view.historyTruncated).toBe(true);
  });

  it('does not mark truncation when fewer events than the cap come back', async () => {
    const { adapters } = makeAdapters({ events: [event({})], users: [{ id: 'u1', name: 'Alice' }] });
    const view = await assembleLakeAccessView(lakeDoc(), {
      ...(adapters as object),
      historyLimit: 10,
      now: NOW,
    } as never);
    expect(view.historyTruncated).toBe(false);
  });

  it('skips the user lookup entirely when there are no principals to resolve', async () => {
    const { adapters, spies } = makeAdapters({});
    await assembleLakeAccessView(lakeDoc(), adapters);
    expect(spies.findByIds).not.toHaveBeenCalled();
  });
});
