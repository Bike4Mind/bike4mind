import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  planPublishVersions,
  planVersionedPublish,
  versionsPushUpdate,
  type PreviousVersionState,
} from './planPublishVersions';

const { quotaMock } = vi.hoisted(() => ({ quotaMock: vi.fn() }));
vi.mock('./checkPublishQuota', async importOriginal => ({
  ...(await importOriginal<typeof import('./checkPublishQuota')>()),
  checkPublishQuota: quotaMock,
}));

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-02-01T00:00:00Z');

const incoming = {
  sha256: 'new',
  publishedBy: 'user1',
  publishedAt: T1,
  size: { totalBytes: 300, fileCount: 2 },
  indexBytes: 120,
};

const previous = (overrides: Partial<PreviousVersionState> = {}): PreviousVersionState => ({
  publishedAt: T0,
  ownerId: 'owner1',
  size: { totalBytes: 100, fileCount: 1 },
  sha256Index: 'old',
  ...overrides,
});

describe('planPublishVersions', () => {
  it('records only the incoming version on a first publish', () => {
    const { versionsToPush, archivedBytes } = planPublishVersions({ previous: null, priorIndex: null, incoming });
    expect(versionsToPush).toEqual([
      { publishedAt: T1, publishedBy: 'user1', size: incoming.size, sha256Index: 'new', indexBytes: 120 },
    ]);
    expect(archivedBytes).toBe(0);
  });

  it('backfills the replaced version with its archived bytes, then adds the incoming one', () => {
    const { versionsToPush, archivedBytes } = planPublishVersions({
      previous: previous({ lastPublishedBy: 'editor1' }),
      priorIndex: Buffer.alloc(80),
      incoming,
    });
    expect(versionsToPush).toEqual([
      {
        publishedAt: T0,
        publishedBy: 'editor1',
        size: { totalBytes: 100, fileCount: 1 },
        sha256Index: 'old',
        indexBytes: 80,
      },
      { publishedAt: T1, publishedBy: 'user1', size: incoming.size, sha256Index: 'new', indexBytes: 120 },
    ]);
    expect(archivedBytes).toBe(80);
  });

  it('falls back to the owner as publisher and omits indexBytes when the prior index is unreadable', () => {
    const { versionsToPush } = planPublishVersions({ previous: previous(), priorIndex: null, incoming });
    expect(versionsToPush[0]).toEqual({
      publishedAt: T0,
      publishedBy: 'owner1',
      size: { totalBytes: 100, fileCount: 1 },
      sha256Index: 'old',
    });
  });

  it('does not backfill a replaced version that history already records', () => {
    const { versionsToPush, archivedBytes } = planPublishVersions({
      previous: previous({ versions: [{ sha256Index: 'old', indexBytes: 50 }] }),
      priorIndex: Buffer.alloc(80),
      incoming,
    });
    expect(versionsToPush.map(v => v.sha256Index)).toEqual(['new']);
    expect(archivedBytes).toBe(50);
  });

  it('adds nothing for an identical re-publish', () => {
    const { versionsToPush } = planPublishVersions({
      previous: previous({ sha256Index: 'new', versions: [{ sha256Index: 'new', indexBytes: 120 }] }),
      priorIndex: Buffer.alloc(120),
      incoming,
    });
    expect(versionsToPush).toEqual([]);
  });
});

describe('versionsPushUpdate', () => {
  it('wraps the entries in a $push with $each, including an empty list', () => {
    const entry = { publishedAt: T1, publishedBy: 'user1', size: incoming.size, sha256Index: 'new', indexBytes: 120 };
    expect(versionsPushUpdate([entry])).toEqual({ $push: { versions: { $each: [entry] } } });
    expect(versionsPushUpdate([])).toEqual({ $push: { versions: { $each: [] } } });
  });
});

describe('planVersionedPublish', () => {
  const quota = {
    ownerId: 'user1',
    orgScopeId: null,
    isAdmin: false,
    replacing: { tier: 'user' as const, scopeId: 'user1', slug: 'page' },
  };

  beforeEach(() => {
    quotaMock.mockReset().mockResolvedValue({ ok: true });
  });

  it('checks the quota with the incoming footprint and the archived bytes after this publish', async () => {
    const result = await planVersionedPublish({
      previous: previous(),
      priorIndex: Buffer.alloc(80),
      incoming,
      quota,
    });
    expect(result.versionsToPush.map(v => v.sha256Index)).toEqual(['old', 'new']);
    expect(result.quota).toEqual({ ok: true });
    expect(quotaMock).toHaveBeenCalledWith({
      ownerId: 'user1',
      orgScopeId: null,
      isAdmin: false,
      replacing: { tier: 'user', scopeId: 'user1', slug: 'page' },
      incoming: { bytes: 300, fileCount: 2, archivedBytes: 80 },
    });
  });

  it('returns a refused quota result unchanged so the caller can map it to its own error', async () => {
    const refused = {
      ok: false as const,
      status: 413 as const,
      code: 'quota_bytes_exceeded' as const,
      error: 'full',
      details: { scope: 'user' as const, limit: 1, current: 1, attempted: 2 },
    };
    quotaMock.mockResolvedValue(refused);
    const result = await planVersionedPublish({ previous: null, priorIndex: null, incoming, quota });
    expect(result.quota).toBe(refused);
    expect(result.versionsToPush).toHaveLength(1);
  });
});
