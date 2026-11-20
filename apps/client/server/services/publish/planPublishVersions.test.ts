import { describe, expect, it } from 'vitest';
import { planPublishVersions, type PreviousVersionState } from './planPublishVersions';

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
