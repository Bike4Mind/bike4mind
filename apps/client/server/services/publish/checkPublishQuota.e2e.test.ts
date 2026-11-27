import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { PUBLISH_QUOTAS } from '@bike4mind/common';
import { PublishedArtifact } from '@bike4mind/database';
import { checkInPlaceRewriteQuota, checkPublishQuota } from './checkPublishQuota';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Against a real database, so the aggregation pipeline itself is under test: a mocked aggregate
// cannot show that page count is no longer enforced, that an owner with no rows reads as zero
// usage, that soft-deleted and overwritten rows stay out of the byte sum, or which archived
// versions count.

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const OWNER = 'owner-1';
const ORG = 'org-1';
const USER_CAP = PUBLISH_QUOTAS.user.maxTotalBytes;
const ORG_CAP = PUBLISH_QUOTAS.org.maxTotalBytes;

interface PageOverrides {
  ownerId?: string;
  tier?: 'user' | 'organization';
  scopeId?: string;
  slug?: string;
  bytes?: number;
  deletedAt?: Date | null;
  sha256Index?: string;
  versions?: ReturnType<typeof version>[];
}

/** A version-history entry; `indexBytes` left out is an entry recorded before it was tracked. */
const version = (sha256Index: string, indexBytes?: number) => ({
  publishedAt: new Date('2026-10-01T00:00:00.000Z'),
  publishedBy: OWNER,
  size: { totalBytes: indexBytes ?? 1024, fileCount: 1 },
  sha256Index,
  ...(indexBytes === undefined ? {} : { indexBytes }),
});

let seq = 0;
const page = (over: PageOverrides = {}) => {
  seq += 1;
  const ownerId = over.ownerId ?? OWNER;
  return {
    publicId: `pub-${seq}`,
    tier: over.tier ?? 'user',
    scopeId: over.scopeId ?? ownerId,
    slug: over.slug ?? `page-${seq}`,
    title: 'Page',
    ownerId,
    visibility: 'public',
    source: { kind: 'bundle' },
    storageKeyPrefix: '',
    manifest: [],
    size: { totalBytes: over.bytes ?? 1024, fileCount: 1 },
    sha256Index: over.sha256Index,
    versions: over.versions ?? [],
    deletedAt: over.deletedAt ?? null,
  };
};

const seed = (pages: ReturnType<typeof page>[]) => PublishedArtifact.insertMany(pages);

describe('checkPublishQuota (real database)', () => {
  it('lets a user who already hosts more pages than the old 100-page cap publish another', async () => {
    await seed(Array.from({ length: 150 }, () => page()));

    const result = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: 1024, fileCount: 1 } });

    expect(result).toEqual({ ok: true });
  });

  it('lets an org that hosts more pages than the old 1,000-page cap take another', async () => {
    await seed(
      Array.from({ length: 1050 }, (_, i) => page({ ownerId: `member-${i % 20}`, tier: 'organization', scopeId: ORG }))
    );

    const result = await checkPublishQuota({
      ownerId: 'member-0',
      orgScopeId: ORG,
      incoming: { bytes: 1024, fileCount: 1 },
    });

    expect(result).toEqual({ ok: true });
  });

  it('allows a publish that lands exactly on the user byte cap and refuses one byte more', async () => {
    await seed([page({ bytes: USER_CAP / 2 }), page({ bytes: USER_CAP / 2 - 1024 })]);

    const exact = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: 1024, fileCount: 1 } });
    expect(exact).toEqual({ ok: true });

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: 1025, fileCount: 1 } });
    if (over.ok) throw new Error('expected the user byte cap to refuse the publish');
    expect(over.status).toBe(413);
    expect(over.code).toBe('quota_bytes_exceeded');
    expect(over.details).toEqual({ scope: 'user', limit: USER_CAP, current: USER_CAP - 1024, attempted: USER_CAP + 1 });
  });

  it('refuses a publish into an org that is full even when the publishing user has room', async () => {
    // Other members fill the org, so only the org ladder can refuse.
    await seed([
      page({ ownerId: 'member-1', tier: 'organization', scopeId: ORG, bytes: ORG_CAP / 2 }),
      page({ ownerId: 'member-2', tier: 'organization', scopeId: ORG, bytes: ORG_CAP / 2 }),
    ]);

    const result = await checkPublishQuota({ ownerId: OWNER, orgScopeId: ORG, incoming: { bytes: 1, fileCount: 1 } });

    if (result.ok) throw new Error('expected the org byte cap to refuse the publish');
    expect(result.status).toBe(413);
    expect(result.code).toBe('quota_bytes_exceeded');
    expect(result.details).toEqual({ scope: 'org', limit: ORG_CAP, current: ORG_CAP, attempted: ORG_CAP + 1 });
  });

  it('reads an owner with no rows as zero usage', async () => {
    const fits = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP, fileCount: 1 } });
    expect(fits).toEqual({ ok: true });

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP + 1, fileCount: 1 } });
    if (over.ok) throw new Error('expected the user byte cap to refuse the publish');
    expect(over.details.current).toBe(0);
  });

  it('leaves soft-deleted rows and the row being overwritten out of the byte sum', async () => {
    await seed([page({ bytes: USER_CAP, deletedAt: new Date() }), page({ slug: 'mine', bytes: USER_CAP })]);
    const incoming = { bytes: USER_CAP, fileCount: 1 };

    const overwrite = await checkPublishQuota({
      ownerId: OWNER,
      incoming,
      replacing: { tier: 'user', scopeId: OWNER, slug: 'mine' },
    });
    expect(overwrite).toEqual({ ok: true });

    const fresh = await checkPublishQuota({ ownerId: OWNER, incoming });
    if (fresh.ok) throw new Error('expected the live row to count toward the user byte cap');
    expect(fresh.details.current).toBe(USER_CAP);
  });
});

// revise.ts and restore.ts rewrite a live page's index.html in place. Only the net change counts.
describe('checkInPlaceRewriteQuota (real database)', () => {
  const SLUG = 'rewritten';
  const PAGE_BYTES = 10_000;
  const rewritten = (over: { tier?: 'user' | 'organization'; scopeId?: string } = {}) => ({
    ownerId: OWNER,
    tier: over.tier ?? ('user' as const),
    scopeId: over.scopeId ?? OWNER,
    slug: SLUG,
    size: { totalBytes: PAGE_BYTES },
  });
  /** The page once rewritten to new content, with no version history to archive. */
  const next = (bytes: number) => ({ bytes, fileCount: 1, sha256Index: 'sha-next', versions: [] });

  it('allows growth that lands exactly on the cap and refuses one byte more, counting only the delta', async () => {
    // The rest of the owner's pages leave exactly 500 bytes of room for this page to grow into.
    const room = 500;
    await seed([page({ slug: SLUG, bytes: PAGE_BYTES }), page({ bytes: USER_CAP - PAGE_BYTES - room })]);

    const exact = await checkInPlaceRewriteQuota({
      artifact: rewritten(),
      next: next(PAGE_BYTES + room),
    });
    expect(exact).toEqual({ ok: true });

    const over = await checkInPlaceRewriteQuota({
      artifact: rewritten(),
      next: next(PAGE_BYTES + room + 1),
    });
    if (over.ok) throw new Error('expected growth past the cap to be refused');
    expect(over.status).toBe(413);
    expect(over.code).toBe('quota_bytes_exceeded');
    // `current` is usage without this page; `attempted` is that plus the page's new total.
    expect(over.details).toEqual({
      scope: 'user',
      limit: USER_CAP,
      current: USER_CAP - PAGE_BYTES - room,
      attempted: USER_CAP + 1,
    });
  });

  it('allows a rewrite that does not grow the page, even for an owner already over the cap', async () => {
    await seed([page({ slug: SLUG, bytes: PAGE_BYTES }), page({ bytes: USER_CAP })]);

    expect(await checkInPlaceRewriteQuota({ artifact: rewritten(), next: next(PAGE_BYTES) })).toEqual({ ok: true });
    expect(await checkInPlaceRewriteQuota({ artifact: rewritten(), next: next(PAGE_BYTES - 1) })).toEqual({ ok: true });

    const grows = await checkInPlaceRewriteQuota({
      artifact: rewritten(),
      next: next(PAGE_BYTES + 1),
    });
    expect(grows.ok).toBe(false);
  });

  it('checks the org ladder for a page in an org scope', async () => {
    await seed([
      page({ tier: 'organization', scopeId: ORG, slug: SLUG, bytes: PAGE_BYTES }),
      page({ ownerId: 'member-2', tier: 'organization', scopeId: ORG, bytes: ORG_CAP - PAGE_BYTES }),
    ]);

    const result = await checkInPlaceRewriteQuota({
      artifact: rewritten({ tier: 'organization', scopeId: ORG }),
      next: next(PAGE_BYTES + 1),
    });

    if (result.ok) throw new Error('expected the full org to refuse the growth');
    expect(result.details.scope).toBe('org');
  });

  it('lets an admin grow a page past the cap', async () => {
    await seed([page({ slug: SLUG, bytes: PAGE_BYTES }), page({ bytes: USER_CAP })]);

    const result = await checkInPlaceRewriteQuota({
      isAdmin: true,
      artifact: rewritten(),
      next: next(PAGE_BYTES * 2),
    });

    expect(result).toEqual({ ok: true });
  });

  it('counts archiving the replaced version as growth, so a same-size revision is refused at the cap', async () => {
    const versions = [version('sha-current', 400)];
    await seed([
      page({ slug: SLUG, bytes: PAGE_BYTES, sha256Index: 'sha-current', versions }),
      page({ bytes: USER_CAP - PAGE_BYTES }),
    ]);

    const result = await checkInPlaceRewriteQuota({
      artifact: { ...rewritten(), sha256Index: 'sha-current', versions },
      next: { ...next(PAGE_BYTES), versions: [...versions, version('sha-next', 400)] },
    });

    if (result.ok) throw new Error('expected the archived version to push the owner past the cap');
    expect(result.details).toEqual({
      scope: 'user',
      limit: USER_CAP,
      current: USER_CAP - PAGE_BYTES,
      attempted: USER_CAP + 400,
    });
  });

  it('allows a rewrite to unchanged content, which archives nothing new, for an owner over the cap', async () => {
    const versions = [version('sha-earlier', 300), version('sha-current', 400)];
    await seed([
      page({ slug: SLUG, bytes: PAGE_BYTES, sha256Index: 'sha-current', versions }),
      page({ bytes: USER_CAP }),
    ]);

    const result = await checkInPlaceRewriteQuota({
      artifact: { ...rewritten(), sha256Index: 'sha-current', versions },
      next: { bytes: PAGE_BYTES, fileCount: 1, sha256Index: 'sha-current', versions },
    });

    expect(result).toEqual({ ok: true });
  });

  it('allows a restore that only swaps which archived version is current, for an owner over the cap', async () => {
    const versions = [version('sha-earlier', 300), version('sha-current', 400)];
    await seed([
      page({ slug: SLUG, bytes: PAGE_BYTES, sha256Index: 'sha-current', versions }),
      page({ bytes: USER_CAP }),
    ]);

    const result = await checkInPlaceRewriteQuota({
      artifact: { ...rewritten(), sha256Index: 'sha-current', versions },
      next: { bytes: PAGE_BYTES - 400 + 300, fileCount: 1, sha256Index: 'sha-earlier', versions },
    });

    expect(result).toEqual({ ok: true });
  });
});

describe('archived versions in usage (real database)', () => {
  it('counts archived versions, but not the current one or entries recorded before indexBytes', async () => {
    await seed([
      page({
        bytes: 1000,
        sha256Index: 'sha-current',
        versions: [version('sha-a', 300), version('sha-legacy'), version('sha-current', 500)],
      }),
    ]);

    const fits = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP - 1300, fileCount: 1 } });
    expect(fits).toEqual({ ok: true });

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP - 1300 + 1, fileCount: 1 } });
    if (over.ok) throw new Error('expected the archived version to count toward the user byte cap');
    expect(over.details.current).toBe(1300);
  });

  it('counts archived versions on the org ladder too', async () => {
    // Another member's org page leaves 1,000 bytes of room only once its archived version counts.
    await seed([
      page({
        ownerId: 'member-2',
        tier: 'organization',
        scopeId: ORG,
        bytes: ORG_CAP - 1300,
        sha256Index: 'sha-current',
        versions: [version('sha-a', 300), version('sha-current', 1000)],
      }),
    ]);
    const publish = (bytes: number) =>
      checkPublishQuota({ ownerId: OWNER, orgScopeId: ORG, incoming: { bytes, fileCount: 1 } });

    expect(await publish(1000)).toEqual({ ok: true });

    const over = await publish(1001);
    if (over.ok) throw new Error('expected the archived version to count toward the org byte cap');
    expect(over.details).toMatchObject({ scope: 'org', current: ORG_CAP - 1000 });
  });

  it('counts a sha recorded twice once, at its larger indexBytes', async () => {
    // Concurrent finalizes can push the same sha twice; its archive is still one blob.
    await seed([
      page({
        bytes: 1000,
        sha256Index: 'sha-current',
        versions: [
          version('sha-a', 300),
          version('sha-a', 350),
          version('sha-current', 500),
          version('sha-current', 500),
        ],
      }),
    ]);

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP, fileCount: 1 } });

    if (over.ok) throw new Error('expected the page to count toward the user byte cap');
    expect(over.details.current).toBe(1350);
  });

  it('treats the latest entry as current on a row without sha256Index, as the serve route does', async () => {
    await seed([page({ bytes: 1000, versions: [version('sha-a', 300), version('sha-latest', 500)] })]);

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP, fileCount: 1 } });

    if (over.ok) throw new Error('expected the page to count toward the user byte cap');
    expect(over.details.current).toBe(1300);
  });

  it('reads a row whose versions field is null or absent as its bundle alone, alongside a counted row', async () => {
    await seed([page({ bytes: 1000, sha256Index: 'sha-current', versions: [version('sha-a', 300)] })]);
    // Written around Mongoose, which would default `versions` to [].
    const noHistory: Record<string, unknown> = page({ bytes: 4000 });
    delete noHistory.versions;
    await PublishedArtifact.collection.insertMany([{ ...page({ bytes: 2000 }), versions: null }, noHistory]);

    const over = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP, fileCount: 1 } });

    if (over.ok) throw new Error('expected the pages to count toward the user byte cap');
    expect(over.details.current).toBe(7300);
  });

  it("leaves a soft-deleted page's archived versions out", async () => {
    await seed([
      page({
        bytes: 1000,
        sha256Index: 'sha-current',
        versions: [version('sha-a', USER_CAP), version('sha-current', 1000)],
        deletedAt: new Date(),
      }),
    ]);

    const result = await checkPublishQuota({ ownerId: OWNER, incoming: { bytes: USER_CAP, fileCount: 1 } });

    expect(result).toEqual({ ok: true });
  });

  it("takes the replaced page's archived versions out with its row, for the caller to add back", async () => {
    await seed([
      page({
        slug: 'mine',
        bytes: 1000,
        sha256Index: 'sha-current',
        versions: [version('sha-a', 300), version('sha-current', 1000)],
      }),
      page({ bytes: USER_CAP - 1300 }),
    ]);
    const replacing = { tier: 'user', scopeId: OWNER, slug: 'mine' } as const;

    const fits = await checkPublishQuota({
      ownerId: OWNER,
      incoming: { bytes: 1000, fileCount: 1, archivedBytes: 300 },
      replacing,
    });
    expect(fits).toEqual({ ok: true });

    const over = await checkPublishQuota({
      ownerId: OWNER,
      incoming: { bytes: 1000, fileCount: 1, archivedBytes: 301 },
      replacing,
    });
    if (over.ok) throw new Error('expected the archived bytes to count');
    expect(over.details).toMatchObject({ current: USER_CAP - 1300, attempted: USER_CAP + 1 });
  });
});
